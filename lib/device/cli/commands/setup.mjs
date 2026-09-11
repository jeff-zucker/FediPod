// setup.mjs — making an identity and its secrets: setup, rotate-key,
// revoke-credential, tokens, passwd, keys.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tildify, rootOf, recordLastUsed, writeJsonAtomic } from '../../home.mjs';
import { insecureUrlReason } from '../../../shared/safefetch.mjs';
import { localFetch } from '../../../client/localapi.mjs';
import { args, flag, has, PROFILE, AP_ROOT, HOME, PORT, recordAgent, useProfile, requireHandle, requireIdentity, askHidden, ask, endAsking, openBrowser, finish, IDENTITY_FLAGS, refuseExistingIdentity, runBrowserSetup } from '../context.mjs';

export async function setup() {
  // --profile names the home before anything is asked, so a collision is
  // knowable now; refuseExistingIdentity exits when it finds one.
  if (PROFILE) { useProfile(PROFILE); refuseExistingIdentity(); }
  // At a terminal with no identity flag, setup asks two things and hands the
  // rest to the page.
  if (process.stdin.isTTY && !has('cli') && !IDENTITY_FLAGS.some(f => args.includes('--' + f))) {
    return runBrowserSetup();
  }
const root = flag('root');
const kind = has('group') ? 'group' : 'person';
const approveJoins = has('group') && has('approve-joins');
const summary = flag('summary');
const icon = flag('icon');
let pod = flag('pod');
const interactive = process.stdin.isTTY;

// Everything that shapes your identity is asked for here, with defaults,
// because these are decisions — the pod name becomes half of your
// permanent address, and nobody should discover that after the fact.
// Flags skip the matching question, so scripted setup is unchanged.
let newAccount = has('new-account');
if (!newAccount && !pod) {
  if (!interactive) {
    console.error('need --email and --handle, plus either --pod <url> or --new-account');
    process.exit(2);
  }
  const have = await ask('do you already have a Solid pod? (y/n)', 'n');
  if (/^y/i.test(have)) {
    // Either tuck the fediverse account into the pod they already have,
    // or make a fresh pod on the same Solid account for it.
    const where = await ask('store your Fediverse account in that pod, or in a new pod? (existing/new)', 'existing');
    if (/^n/i.test(where)) newAccount = true;
    else pod = await ask('your pod address (e.g. https://you.solidcommunity.net/)');
  } else {
    newAccount = true;
  }
}
if (!newAccount && !pod) { console.error('no pod given'); process.exit(2); }

const issuer = flag('issuer') || await ask('Solid identity provider', 'https://solidcommunity.net');
// Before the password is asked for, let alone sent. The issuer is where it
// goes and the pod is where the credential it buys is used, so an http:
// address off this machine puts both in clear. Loopback is exempt: it never
// reaches a network interface, and a pod on this machine is an ordinary way
// to run this.
for (const [url, what] of [[issuer, 'identity provider address'], [pod, 'pod address']]) {
  const bad = insecureUrlReason(url, what);
  if (bad) { console.error(bad); process.exit(2); }
}
const email = flag('email') || await ask(`account email at ${new URL(issuer).host}`);
const handle = flag('handle') || await ask('handle (the name in your address; permanent)');
if (!email || !handle) {
  console.error('an email and a handle are required');
  process.exit(2);
}
// Before anything irreversible: the account creation and the mint are both
// one-way, and a credential is shown once. A home that cannot be decided has
// to be refused here, not after there is something to lose.
requireHandle(handle);
useProfile(PROFILE || handle);
refuseExistingIdentity();
const podName = newAccount
  ? (flag('pod-name') || await ask('pod name (this becomes the domain of your address)', handle))
  : null;
const name = flag('name') || await ask('display name (shown above your address)', handle);

// A handle resolves through <host>/.well-known/webfinger, so it only works
// when the pod owns the root of its host. Whether a NEW pod gets its own
// subdomain is the server's call, so promise nothing here we cannot keep.
const { webfingerHost } = await import(new URL('../../../../lib/core/wire.mjs', import.meta.url));
const issuerHost = new URL(issuer).host;
const wfHost = newAccount ? null : webfingerHost(pod);
// A person warned about an unresolvable handle is the one who suffers, so a
// warning is their call to accept. Nobody could ever find this group, and the
// people it would fail are not the operator reading the warning.
if (kind === 'group' && !newAccount && !wfHost) {
  console.error(`${pod} is a path on ${new URL(pod).host}, not the root of its own host.`);
  console.error('WebFinger is answered only at a host root, so nobody could find this group.');
  console.error('Give the group a pod of its own:  fedipod setup --group --new-account');
  process.exit(2);
}
console.log(kind === 'group' ? '\nThe group will be:\n' : '\nYou will be:\n');
console.log(`  ${name}`);
if (wfHost) {
  console.log(`  @${handle}@${wfHost}\n`);
} else if (newAccount) {
  console.log(`  @${handle}@${podName}.${issuerHost}\n`);
  console.log(`— provided ${issuerHost} gives each pod its own subdomain. Some servers put`);
  console.log(`pods at ${issuerHost}/${podName}/ instead, and a pod sharing a host cannot`);
  console.log('answer WebFinger for an address. Setup checks which you got and says so');
  console.log('before publishing anything.\n');
} else {
  console.log(`  @${handle}@${new URL(pod).host}   —   WILL NOT RESOLVE\n`);
  console.log(`This pod is ${pod} — a path on ${new URL(pod).host}, not the root of its own`);
  console.log('host. WebFinger is answered only at a host root, which this pod cannot');
  console.log('write to, so other servers will not find you. Posting and reading still');
  console.log('work; being discovered does not.\n');
}
console.log('The display name can be changed later; the handle and pod cannot.');
const go = await ask(newAccount
  ? (kind === 'group' ? 'create pod and group? (y/n)' : 'create pod and Fediverse account? (y/n)')
  : (kind === 'group' ? 'create group on this pod? (y/n)' : 'create Fediverse account on this pod? (y/n)'), 'y');
if (!/^y/i.test(go)) { console.log('nothing was created'); process.exit(0); }
endAsking();                           // hand the tty to the password prompt

const password = process.env.AP_PASSWORD || await askHidden(`password for ${email} at ${issuer}: `);

if (newAccount) {
  const { createAccountWithPod } = await import(new URL('../../../../lib/device/account.mjs', import.meta.url));
  const made = await createAccountWithPod({ issuer, email, password, podName });
  pod = made.pod;
  console.log(`account + pod created: ${pod}`);
  if (!webfingerHost(pod)) {
    console.log(`\n${issuerHost} created the pod at a path rather than on its own subdomain,`);
    console.log(`so @${handle}@\u2026 cannot be discovered by other Fediverse servers.`);
    const cont = kind === 'group' ? 'n' : (interactive ? await ask('continue anyway? (y/n)', 'n') : 'y');
    endAsking();
    if (!/^y/i.test(cont)) {
      console.log('stopping \u2014 the pod exists, but no actor was published');
      process.exit(0);
    }
  }
}

const { mintCredential } = await import(new URL('../../../../lib/device/remote.mjs', import.meta.url));
// New credentials only: one already registered keeps the name it was minted
// under, so existing pods stay as they are unless they are set up again.
const credential = await mintCredential({ origin: issuer, email, password, name: 'fedipod' });
const rec = {
  ...credential,
  remotePod: pod.endsWith('/') ? pod : pod + '/',
  // The private half goes on THIS machine, exactly as the browser setup does
  // (lib/setup.mjs). Omitting it here meant the two paths produced different
  // installs from the same answers: the CLI put the timeline, contacts,
  // blocklist and notifications on the pod — the layout the relay design
  // exists to avoid, and the one that makes receiving a post cost pod writes.
  // It also made provisioning write a tree it did not need, which is where a
  // slow server showed it up.
  privateRoot: flag('private-root')
    || pathToFileURL(path.join(HOME, 'private')).href + '/',
  ...(root ? { root } : {}),
  ...(flag('keys') === 'pod' ? { keysMode: 'pod' } : {}),
  ...(has('rotate-key') ? { rotateKeyOnce: true } : {}),
  // What shape this install is. Both setup paths stamp it, so `upgrade` can
  // tell an old install from a new one rather than inferring it.
  layout: (await import(new URL('../../../../lib/device/migrate.mjs', import.meta.url))).CURRENT_LAYOUT,
};
fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
writeJsonAtomic(path.join(HOME, 'credential.json'), rec);
// The one you just made is the one you are using.
if (rootOf(HOME) === AP_ROOT) recordLastUsed(AP_ROOT, path.basename(HOME));
recordAgent({ port: PORT, handle });   // later commands need no --port
console.log(`credential minted and saved to ${path.join(HOME, 'credential.json')}`);

const { Agent } = await import(new URL('../../../../run-agent.mjs', import.meta.url));
const agent = new Agent({ home: HOME, log: (...a) => console.log('[setup]', ...a) });
await agent.bootstrap({ handle, name, root, kind, approveJoins, summary, icon });
await agent.connect({ repair: false });   // publishProfile below is the publish
await agent.publisher.publishProfile();
await agent.store.flush();
const finalHost = webfingerHost(rec.remotePod);
const what = kind === 'group' ? 'group' : 'actor';
console.log(finalHost
  ? `${what} published: @${handle}@${finalHost}`
  : `${what} published, but not reachable as a handle \u2014 ${rec.remotePod} is not a host root`);

// Straight into serving — setup ends with a working client in the browser.
const { startAdmin } = await import(new URL('../../../../lib/device/admin/index.mjs', import.meta.url));
const { hostLabel } = await import(new URL('../../../../lib/shared/guard.mjs', import.meta.url));
startAdmin({ port: PORT, handle, gateToken: process.env.AP_GATE_TOKEN || '', agent, log: (...a) => console.log('[ap]', ...a) });
const shutdown = () => {
  setTimeout(() => process.exit(0), 1500).unref();   // never hang a stop on a slow pod
  try { fs.rmSync(path.join(HOME, 'agent.pid'), { force: true }); } catch {}
  Promise.allSettled([agent.store.flush(), agent.lease?.release()]).finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// The named origin, and the instance to log the client into is that same
// origin. Opening the shared one and then telling you to log in there is how
// two identities end up sharing a browser storage bucket, and a client on the
// shared origin shows whichever account it happens to hold.
const label = hostLabel(handle);
const authority = `${label ? label + '.' : ''}localhost:${PORT}`;
const url = `http://${authority}/`;
if (kind === 'group') {
  console.log(`group running on ${url} — see \`fedipod members\``);
} else {
  console.log(`agent running — opening ${url} (log in with instance ${authority})`);
  openBrowser(url);
}
}

export async function rotateKey() {
requireIdentity();
const { Agent } = await import(new URL('../../../../run-agent.mjs', import.meta.url));
const agent = new Agent({ home: HOME, log: (...a) => console.log('[rotate-key]', ...a) });
// A home whose keys.json is gone or truncated cannot connect() at all:
// resolveKeys refuses to mint over a key the actor already publishes, which
// is the right default — minting silently would invalidate every signature
// the other device can still make. It did leave the advice that refusal
// prints ("run fedipod rotate-key") a dead end, though, because this
// command connects first and meets the same refusal. --force arms the
// one-shot rotation in the credential so the connect can get past it.
const forced = has('force');
const rotateCredPath = path.join(HOME, 'credential.json');
if (forced) {
  const cred = JSON.parse(fs.readFileSync(rotateCredPath, 'utf8'));
  writeJsonAtomic(rotateCredPath, { ...cred, rotateKeyOnce: true });
  console.log('--force: the replacement key is minted as the agent connects\n');
}
// Read-only until you say yes: connecting for real acquires the lease and
// starts the whole active agent — a destructive inbox drain, a channel
// subscription, ACL probes and a tag-feed sweep — before the prompt.
if (!await agent.connect({ act: false })) {
  console.error('nothing to rotate — no configured agent in this AP_HOME');
  process.exit(2);
}
const cfg = agent.store.getConfig();
console.log(`\nRotating the signing key for @${cfg.handle}@${new URL(cfg.remotePod).host}\n`);
console.log('  · a new keypair replaces the one in this home');
console.log('  · the actor document is republished so other servers learn it');
console.log('  · ANY OTHER DEVICE holding the old key stops being able to sign\n');
const ans = has('yes') ? 'y' : await ask('rotate now? (y/n)', 'n');
endAsking();
if (!/^y/i.test(ans)) {
  // --force arms the one-shot rotation before the prompt, so the preview
  // connect can read past the mint refusal. Declining has to disarm it, or
  // "key unchanged" would be a lie: the next ordinary start would rotate,
  // and nothing on that path republishes the actor.
  if (forced) {
    try {
      const { rotateKeyOnce, ...rest } = JSON.parse(fs.readFileSync(rotateCredPath, 'utf8'));
      writeJsonAtomic(rotateCredPath, rest);
    } catch { /* the credential moved under us; the flag goes with it */ }
  }
  console.log('key unchanged');
  process.exit(0);
}
await agent.connect();                          // now it may act
if (forced) {
  // connect() has already minted it; all that is left is telling the
  // fediverse. Calling rotateKey here would mint a second one for nothing.
  await agent.publisher.publishProfile();
  console.log('rotated and republished');
} else {
  const r = await agent.rotateKey();
  console.log(r.changed ? 'rotated and republished' : 'no change — the key was already fresh');
}
await finish(agent);
}

export async function revokeCredential() {
// The credential file cannot be protected from anything running as you —
// so the answer to a suspected leak is to kill it server-side, fast.
const { Agent } = await import(new URL('../../../../run-agent.mjs', import.meta.url));
const { revokeCredentialViaAccount } = await import(new URL('../../../../lib/device/remote.mjs', import.meta.url));
const agent = new Agent({ home: HOME, log: () => {} });
const cred = agent.readCredential();
if (!cred) { console.error('no credential to revoke'); process.exit(2); }
const email = flag('email');
if (!email) { console.error('need --email <account email> (the account password is prompted)'); process.exit(2); }
const password = process.env.AP_PASSWORD || await askHidden(`password for ${email} at ${cred.issuerOrigin}: `);
const ok = await revokeCredentialViaAccount({
  origin: cred.issuerOrigin, email, password, resource: cred.resource,
}).catch(e => { console.error(`revoke failed: ${e.message}`); return false; });
if (ok) {
  fs.rmSync(path.join(HOME, 'credential.json'), { force: true });
  console.log('credential revoked server-side and deleted locally — run setup again to reconnect');
} else {
  console.error('server did not confirm revocation — revoke it from the account dashboard');
  console.error(`(credential resource: ${cred.resource || 'unknown — dashboard only'})`);
  process.exit(1);
}
}

export async function tokens() {
const { Agent } = await import(new URL('../../../../run-agent.mjs', import.meta.url));
const { RemotePod } = await import(new URL('../../../../lib/device/remote.mjs', import.meta.url));
const { apUrls } = await import(new URL('../../../../lib/core/wire.mjs', import.meta.url));
const agent = new Agent({ home: HOME, log: () => {} });
const cred = agent.readCredential();
if (!cred) { console.error('no credential — run setup first'); process.exit(2); }
agent.remote = new RemotePod(cred);
await agent.remote.warmup();
agent.urls = apUrls(cred.remotePod, cred.root);
agent.store.attach(agent.privateStorage(cred, 'state'));   // honours privateRoot
await agent.store.load();
const recs = agent.store.read('masto-tokens.json', [])
  .map(r => (typeof r === 'string' ? { token: r, createdAt: null } : r));
if (has('revoke-all')) {
  agent.store.write('masto-tokens.json', []);
  await agent.store.flush();
  console.log(`revoked ${recs.length} token(s) — every logged-in client must log in again`);
} else if (flag('revoke')) {
  const prefix = flag('revoke');
  const kept = recs.filter(r => !r.token.startsWith(prefix));
  agent.store.write('masto-tokens.json', kept);
  await agent.store.flush();
  console.log(`revoked ${recs.length - kept.length} token(s) matching "${prefix}"`);
} else {
  if (!recs.length) console.log('no client tokens issued');
  for (const r of recs) {
    const age = r.createdAt ? `${Math.round((Date.now() - r.createdAt) / 86400000)}d old` : 'undated';
    console.log(`${r.token.slice(0, 8)}…  ${age}`);
  }
  console.log('\nrevoke with: fedipod tokens --revoke <prefix>   (or --revoke-all)');
}
}

export async function passwd() {
requireIdentity();
const { Agent } = await import(new URL('../../../../run-agent.mjs', import.meta.url));
const { hashPassword } = await import(new URL('../../../../lib/client/masto/index.mjs', import.meta.url));
const { RemotePod } = await import(new URL('../../../../lib/device/remote.mjs', import.meta.url));
const { apUrls } = await import(new URL('../../../../lib/core/wire.mjs', import.meta.url));
const agent = new Agent({ home: HOME, log: () => {} });
const cred = agent.readCredential();
if (!cred) { console.error('no credential — run setup first'); process.exit(2); }
const pw = await askHidden('new UI password: ');
if (!pw) { console.error('empty password — aborted'); process.exit(2); }
agent.remote = new RemotePod(cred);
await agent.remote.warmup();
agent.urls = apUrls(cred.remotePod, cred.root);
agent.store.attach(agent.privateStorage(cred, 'state'));   // honours privateRoot
await agent.store.load();
const config = agent.store.getConfig();
if (!config) { console.error('pod state empty — run setup first'); process.exit(2); }
agent.store.setConfig({ ...config, uiPassword: hashPassword(pw) });
await agent.store.flush();
console.log('UI password set — /oauth/authorize now shows a login form (restart a running agent to pick it up)');
}

export async function keys() {
// Where the signing key lives; `--to pod` moves it into pod state — with
// the state store on a pod every device reaches, that is what lets them
// all sign as one actor. `--to local` flips back: the next start adopts
// the pod copy onto this machine and removes it from the pod.
requireIdentity();
const localKeyFile = path.join(HOME, 'keys.json');
const to = flag('to');
if (!to) {
  const cred0 = JSON.parse(fs.readFileSync(path.join(HOME, 'credential.json'), 'utf8'));
  console.log(fs.existsSync(localKeyFile)
    ? `signing key: ${tildify(localKeyFile)} (this machine only)`
    : cred0.keysMode === 'pod'
      ? 'signing key: pod state (shared by every device that reaches the state store)'
      : 'signing key: none found here — it mints on the next start');
  process.exit(0);
}
if (!['pod', 'local'].includes(to)) {
  console.error('usage: fedipod keys [--to pod|local]');
  process.exit(2);
}
// The running agent holds the key and the config in memory — stop it first.
const answering = await localFetch(HOME, PORT, `/status`).then(r => r.ok).catch(() => false);
if (answering) {
  console.error(`an agent is answering on :${PORT} — stop it first (fedipod stop), then re-run`);
  process.exit(2);
}
const credPath = path.join(HOME, 'credential.json');
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
if (to === 'local') {
  if (cred.keysMode !== 'pod') { console.log('keys are already local'); process.exit(0); }
  delete cred.keysMode;
  writeJsonAtomic(credPath, cred);
  console.log('keys set to local — the next start adopts the pod copy onto this machine and removes it from the pod');
  process.exit(0);
}
if (cred.keysMode === 'pod' && !fs.existsSync(localKeyFile)) {
  console.log('keys are already pod-held');
  process.exit(0);
}
const { Agent } = await import(new URL('../../../../run-agent.mjs', import.meta.url));
const { RemotePod } = await import(new URL('../../../../lib/device/remote.mjs', import.meta.url));
const { apUrls } = await import(new URL('../../../../lib/core/wire.mjs', import.meta.url));
const { moveKeysToPod } = await import(new URL('../../../../lib/core/keys.mjs', import.meta.url));
const agent = new Agent({ home: HOME, log: () => {} });
agent.remote = new RemotePod(cred);
await agent.remote.warmup();
agent.store.attach(agent.privateStorage(cred, 'state'));
await agent.store.load();
const gwActor = agent.store.getConfig()?.gateway?.frontActor;
const urls = apUrls(cred.remotePod, cred.root,
  gwActor ? { publicBase: gwActor.replace(/ap\/actor\/?$/, '') } : undefined);
try {
  await moveKeysToPod(agent.store, { localDir: HOME, actorId: urls.actor, log: console.log });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
cred.keysMode = 'pod';
writeJsonAtomic(credPath, cred);
if (cred.privateRoot) {
  console.log(`note: this identity's state store is ${cred.privateRoot} — devices share the key`);
  console.log('only when the state store is a pod they can all reach (`fedipod state --to pod`).');
}
console.log('done — restart the agent');
}
