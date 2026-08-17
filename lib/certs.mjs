// certs.mjs — TLS for the local agent, minted per machine. Nothing here is
// ever packaged or shared: a certificate that ships with the app would carry
// one private key for every install, which protects nobody. Two modes:
//
//   plain (default)  one self-signed certificate for the loopback names.
//                    Clients that allow an exception accept it once.
//   trust (opt-in)   a local CA signs the server certificate, and the CA —
//                    never the server key — is what the user adds to their
//                    trust store. `fedipod https --trust` sets it up.
//
// The certificate covers localhost, *.localhost (every named agent origin),
// and both loopback addresses, so one file serves all identities on the
// machine. Files live under <root>/certs/, 0600.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
  let key = readPem(dir, FILES.key);
  let cert = readPem(dir, FILES.cert);
  const stale = !key || !cert || daysLeft(cert) < REMINT_DAYS || !coversLocalhost(cert)
    || (trust && !issuedBy(cert, caCert));
  if (stale) {
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

// The opt-in: mint the local CA (once) and re-mint the server certificate
// under it. The CA's key never leaves the certs directory; the CA's CERT is
// what the user installs in a trust store.
export function enableTrust(dir, { log = () => {} } = {}) {
  if (!readPem(dir, FILES.caKey)) {
    const hostname = (process.env.HOSTNAME || 'this machine').toString().slice(0, 32);
    const ca = makeCert({ subjectCN: `FediPod Local CA (${hostname})`, isCA: true, days: CA_DAYS });
    writePem(dir, FILES.caKey, ca.keyPem);
    writePem(dir, FILES.caCert, ca.certPem);
    log('minted the local CA');
  }
  // Force a re-mint of the leaf under the CA.
  fs.rmSync(p(dir, FILES.cert), { force: true });
  fs.rmSync(p(dir, FILES.key), { force: true });
  const tls = ensureLocalTls(dir, { log });
  return { ...tls, caCertPath: p(dir, FILES.caCert) };
}

export const certPaths = (dir) => ({
  key: p(dir, FILES.key), cert: p(dir, FILES.cert),
  caKey: p(dir, FILES.caKey), caCert: p(dir, FILES.caCert),
});
