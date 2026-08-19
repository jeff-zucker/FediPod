// certs.mjs — TLS for the local agent, minted per machine. Nothing here is
// ever packaged or shared: a certificate that ships with the app would carry
// one private key for every install, which protects nobody.
//
// The first agent start mints a local CA and signs the server certificate
// with it, and the CA — never the server key — is placed in the user's
// browser trust store where that can be done without privileges (NSS on
// Linux). The CA carries a critical name constraint limiting it to localhost
// names and loopback addresses, so even a stolen CA key can never vouch for
// a real site. `fedipod https --trust` remains for the system-wide store and
// for setups where the automatic step could not run.
//
// The certificate covers localhost, *.localhost (every named agent origin),
// and both loopback addresses, so one file serves all identities on the
// machine. Files live under <root>/certs/, 0600.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const forge = require('node-forge');

const FILES = {
  key: 'localhost-key.pem',
  cert: 'localhost-cert.pem',
  caKey: 'ca-key.pem',
  caCert: 'ca-cert.pem',
};
// Apple platforms reject leaf certificates valid longer than ~825 days.
const LEAF_DAYS = 820;
const CA_DAYS = 3650;
const REMINT_DAYS = 30;        // re-mint when this close to expiry

const SANS = [
  { type: 2, value: 'localhost' },
  { type: 2, value: '*.localhost' },
  { type: 7, ip: '127.0.0.1' },
  { type: 7, ip: '::1' },
];

const p = (dir, name) => path.join(dir, name);
const readPem = (dir, name) => {
  try { return fs.readFileSync(p(dir, name), 'utf8'); } catch { return null; }
};
const writePem = (dir, name, pem) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(p(dir, name), pem, { mode: 0o600 });
};

// RFC 5280 name constraints, permitted-only: dNSName "localhost" (which by
// the RFC's left-labels rule also covers every *.localhost), 127.0.0.0/8 and
// ::1. Critical, so a validator that cannot enforce it rejects the chain
// rather than ignoring the limit. forge has no builder for this extension,
// so the DER is assembled here.
function nameConstraintsExtension() {
  const { asn1 } = forge;
  const dns = (name) => asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, name);
  const ip = (bytes) => asn1.create(asn1.Class.CONTEXT_SPECIFIC, 7, false, bytes);
  const subtree = (generalName) =>
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [generalName]);
  const permitted = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
    subtree(dns('localhost')),
    subtree(ip('\x7f\x00\x00\x00\xff\x00\x00\x00')),                    // 127.0.0.0/8
    subtree(ip('\x00'.repeat(15) + '\x01' + '\xff'.repeat(16))),        // ::1/128
  ]);
  const der = asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [permitted]));
  return { id: '2.5.29.30', critical: true, value: der.getBytes() };
}

function makeCert({ subjectCN, issuer = null, issuerKeyPem = null, isCA = false, days }) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02' + crypto.randomBytes(15).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600e3);
  cert.validity.notAfter = new Date(Date.now() + days * 24 * 3600e3);
  const subject = [{ name: 'commonName', value: subjectCN }, { name: 'organizationName', value: 'FediPod' }];
  cert.setSubject(subject);
  cert.setIssuer(issuer || subject);
  cert.setExtensions(isCA
    ? [{ name: 'basicConstraints', cA: true, critical: true },
       { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
       nameConstraintsExtension(),
       { name: 'subjectKeyIdentifier' }]
    : [{ name: 'basicConstraints', cA: false },
       { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
       { name: 'extKeyUsage', serverAuth: true },
       { name: 'subjectAltName', altNames: SANS }]);
  const signingKey = issuerKeyPem ? forge.pki.privateKeyFromPem(issuerKeyPem) : keys.privateKey;
  cert.sign(signingKey, forge.md.sha256.create());
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

const daysLeft = (certPem) => {
  try {
    const x = new crypto.X509Certificate(certPem);
    return (new Date(x.validTo).getTime() - Date.now()) / (24 * 3600e3);
  } catch { return -1; }
};
const coversLocalhost = (certPem) => {
  try {
    return /\*\.localhost/.test(new crypto.X509Certificate(certPem).subjectAltName || '');
  } catch { return false; }
};

// What an agent calls at boot: the current server key + cert, minted or
// re-minted as needed. Trust mode is sticky — once a CA exists, re-mints are
// signed by it, so an installed trust anchor keeps working across renewals.
export function ensureLocalTls(dir, { log = () => {} } = {}) {
  const caKey = readPem(dir, FILES.caKey);
  const caCert = readPem(dir, FILES.caCert);
  const trust = !!(caKey && caCert);
  const isStale = (k, c) => !k || !c || daysLeft(c) < REMINT_DAYS || !coversLocalhost(c)
    || (trust && !issuedBy(c, caCert));
  let key = readPem(dir, FILES.key);
  let cert = readPem(dir, FILES.cert);
  if (isStale(key, cert)) {
    // One minter at a time: agents on a machine start together, and the key
    // and certificate are two files — unlocked, two concurrent minters can
    // interleave and pair one's key with the other's certificate. Losers
    // wait for the winner and take its files; a lock left by a crash is
    // stolen once it is a minute old.
    const lock = p(dir, '.mint-lock');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let locked = false;
    try { fs.mkdirSync(lock); locked = true; } catch { /* someone else is minting */ }
    if (!locked) {
      const tick = new Int32Array(new SharedArrayBuffer(4));
      for (let i = 0; i < 100; i++) {
        Atomics.wait(tick, 0, 0, 100);
        if (!fs.existsSync(lock)) break;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) { fs.rmdirSync(lock); break; }
        } catch { break; }
      }
      key = readPem(dir, FILES.key);
      cert = readPem(dir, FILES.cert);
      if (!isStale(key, cert)) return { key, cert, trust, dir, expiresInDays: Math.floor(daysLeft(cert)) };
      try { fs.mkdirSync(lock); locked = true; } catch { /* still contended — mint anyway */ }
    }
    try {
      const minted = makeCert({
        subjectCN: 'localhost',
        ...(trust ? { issuer: caSubject(caCert), issuerKeyPem: caKey } : {}),
        days: LEAF_DAYS,
      });
      writePem(dir, FILES.key, minted.keyPem);
      writePem(dir, FILES.cert, minted.certPem);
      key = minted.keyPem;
      cert = minted.certPem;
      log(`minted a ${trust ? 'CA-signed' : 'self-signed'} https certificate for localhost + *.localhost`);
    } finally {
      if (locked) { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
    }
  }
  return { key, cert, trust, dir, expiresInDays: Math.floor(daysLeft(cert)) };
}

const caSubject = (caCertPem) => forge.pki.certificateFromPem(caCertPem).subject.attributes
  .map(a => ({ name: a.name, value: a.value }));
const issuedBy = (certPem, caCertPem) => {
  try {
    return new crypto.X509Certificate(certPem).checkIssued(new crypto.X509Certificate(caCertPem));
  } catch { return false; }
};

// Mint the local CA once. First writer wins: agents on one machine start
// together at boot, and the key file is claimed exclusively so exactly one
// of them mints. A loser whose caCert read races the winner's second write
// runs self-signed for that one boot and heals on the next.
function mintCaOnce(dir, log) {
  if (readPem(dir, FILES.caKey)) return;
  const hostname = (process.env.HOSTNAME || 'this machine').toString().slice(0, 32);
  const ca = makeCert({ subjectCN: `FediPod Local CA (${hostname})`, isCA: true, days: CA_DAYS });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(p(dir, FILES.caKey), ca.keyPem, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') return;   // another agent minted first
    throw e;
  }
  fs.writeFileSync(p(dir, FILES.caCert), ca.certPem, { mode: 0o600 });
  log('minted the local CA (name-constrained to localhost)');
}

// Put the CA where this user's browsers look, where that needs no privilege
// (NSS on Linux — Chromium reads it). Once per CA: a marker beside the certs
// remembers the install, and a rotated CA installs again. AP_TRUST_INSTALL=0
// disables the whole step (the test suite sets it, so throwaway agents never
// touch a real profile's trust store).
export function installBrowserTrust(dir, { log = () => {} } = {}) {
  if (process.env.AP_TRUST_INSTALL === '0') return false;
  const caCert = readPem(dir, FILES.caCert);
  if (!caCert) return false;
  const digest = crypto.createHash('sha256').update(caCert).digest('hex');
  const markerFile = p(dir, 'trust-installed.json');
  try {
    if (JSON.parse(fs.readFileSync(markerFile, 'utf8')).sha256 === digest) return true;
  } catch { /* not installed yet */ }
  if (process.platform !== 'linux') return false;   // elevated stores; `https --trust` prints the step
  try {
    execFileSync('certutil', ['-d', `sql:${path.join(os.homedir(), '.pki/nssdb')}`, '-A',
      '-t', 'C,,', '-n', 'FediPod Local CA', '-i', p(dir, FILES.caCert)], { stdio: 'pipe' });
  } catch {
    log('browser trust store not updated (certutil unavailable) — `fedipod https --trust` prints the manual step');
    return false;
  }
  fs.writeFileSync(markerFile, JSON.stringify({ sha256: digest, at: new Date().toISOString() }) + '\n',
    { mode: 0o600 });
  log('installed the local CA in your browser trust store (NSS)');
  return true;
}

// What an agent calls at boot: trusted https with nothing asked of the user.
// The CA is minted on first use, the leaf rides it from then on, and the CA
// lands in the browser trust store when that can be done quietly.
export function ensureTrustedTls(dir, { log = () => {} } = {}) {
  try { mintCaOnce(dir, log); } catch { /* self-signed this boot */ }
  const tls = ensureLocalTls(dir, { log });
  if (tls.trust) installBrowserTrust(dir, { log });
  return tls;
}

// The manual path: mint the CA (once) and re-mint the server certificate
// under it, for the printed system-store step. The CA's key never leaves the
// certs directory; the CA's CERT is what a trust store accepts.
export function enableTrust(dir, { log = () => {} } = {}) {
  mintCaOnce(dir, log);
  // Force a re-mint of the leaf under the CA.
  fs.rmSync(p(dir, FILES.cert), { force: true });
  fs.rmSync(p(dir, FILES.key), { force: true });
  const tls = ensureLocalTls(dir, { log });
  installBrowserTrust(dir, { log });
  return { ...tls, caCertPath: p(dir, FILES.caCert) };
}

export const certPaths = (dir) => ({
  key: p(dir, FILES.key), cert: p(dir, FILES.cert),
  caKey: p(dir, FILES.caKey), caCert: p(dir, FILES.caCert),
});
