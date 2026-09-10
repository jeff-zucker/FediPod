// check-pod-calls.mjs — keeps the pod library a library, and keeps pod I/O
// inside it.
//
// Two jobs. The first is that the layer does not erode: once every pod request
// goes through a named operation, one `remote.putJson(...)` added back at a
// call site is invisible in review and undoes the property quietly. The second
// is that lib/pod/ stays EXTRACTABLE — no imports above itself, no Node
// built-ins, its one dependency confined — because "we could lift this out"
// stops being true the first time something reaches upward, and nobody notices
// until they try.
//
// Comments are stripped before every check. The rules are about code; the
// files explain themselves in prose, and prose that mentions node:dns or
// names the application it grew up in is not a violation.
//
//   node scripts/check-pod-calls.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POD = path.join(root, 'lib/pod');

let failures = 0;
const fail = (msg) => { console.log(`FAIL  ${msg}`); failures++; };
const pass = (msg) => console.log(`PASS  ${msg}`);

const read = (p) => fs.readFileSync(p, 'utf8');
// Prose is stripped LINE BY LINE, never with a regex spanning lines. A
// `/*...*/` matcher looks obvious and is not: a `*/` inside a regex literal or
// a string ends the match early, and everything up to the next one disappears —
// which silently deleted the very code these rules exist to look at, and left
// the check passing. Every comment in this project's style occupies whole
// lines, so dropping whole comment lines is both sufficient and safe.
const code = (src) => {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.endsWith('*/') || t === '*/') inBlock = false; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    out.push(line);
  }
  return out.join('\n');
};

const podFiles = fs.readdirSync(POD).filter((f) => f.endsWith('.mjs'));

// ---- 1. the layer: pod I/O lives behind a named operation ----

// The files that run the browser agent and the gateway. Node-only code is
// deliberately out of scope for this pass and must not fail the check.
const IN_SCOPE = [
  'lib/publisher.mjs', 'lib/intake.mjs', 'lib/social.mjs', 'lib/mastoapi.mjs',
  'lib/gateway-core.mjs', 'lib/front-core.mjs',
  'web/app/agent.mjs', 'web/app/signup.mjs', 'web/app/boot.mjs',
  'web/app/admin-facade.mjs', 'web/app/keys-browser.mjs',
];
const VERBS = /\b(?:remote|pod)\??\.(put|putJson|getJson|delete|setAcl|listContainer|aclUrlFor|aclWritable|patchDocument|linkAccountInProfile|aclDoc)\(/;

for (const rel of IN_SCOPE) {
  const hits = code(read(path.join(root, rel))).split('\n')
    .map((l, i) => [i + 1, l]).filter(([, l]) => VERBS.test(l));
  if (hits.length) {
    fail(`${rel} calls a transport verb directly — that belongs in a lib/pod/ operation`);
    for (const [n, l] of hits.slice(0, 5)) console.log(`        ${rel}:${n}  ${l.trim()}`);
  }
}
if (!failures) pass('every in-scope caller reaches the pod through a named operation');

// ---- 2. the deny-list cannot be routed around ----
{
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'dist', 'site', '.git', 'claude', 'phanpy', 'ui', 'packages'].includes(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith('.mjs') && p !== path.join(POD, 'transport.mjs')) {
        // A DELETE is only a problem when it is sent on a RAW fetch. One sent
        // through an injected fetcher is going through the transport — that is
        // what `storage.mjs` does, and is the point of it being injected.
        const src = code(read(p));
        for (const m of src.matchAll(/method:\s*['"]DELETE['"]/g)) {
          const before = src.slice(Math.max(0, m.index - 240), m.index);
          const call = before.lastIndexOf('(');
          const receiver = before.slice(Math.max(0, call - 60), call + 1);
          if (/(?:^|[^.\w])(?:window\.)?fetch\($/.test(receiver) || /session\.fetch\($/.test(receiver)) {
            offenders.push(`${path.relative(root, p)} (raw fetch)`);
          }
        }
      }
    }
  };
  walk(path.join(root, 'lib'));
  walk(path.join(root, 'web/app'));
  if (offenders.length) fail(`a DELETE is issued outside the transport, skipping the deny-list: ${offenders.join(', ')}`);
  else pass('every DELETE goes through the transport, where the deny-list is');
}

// ---- 3. the signing key is never written without its ACL ----
{
  const s = code(read(path.join(root, 'web/app/signup.mjs')));
  if (/keys\.json[\s\S]{0,200}method:\s*['"]PUT['"]/.test(s) || /method:\s*['"]PUT['"][\s\S]{0,200}keys\.json/.test(s)) {
    fail('signup writes keys.json directly — it must go through state.provisionKey, which sets the ACL first');
  } else pass('the signing key is written only by the operation that locks the container first');
}

// ---- 4. lib/pod/ reaches nothing above itself ----
{
  let bad = 0;
  for (const f of podFiles) {
    const src = code(read(path.join(POD, f)));
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec.startsWith('../')) { fail(`lib/pod/${f} imports ${spec} — the library may not reach above itself`); bad++; }
      if (spec.startsWith('node:')) { fail(`lib/pod/${f} imports ${spec} — the library must run in a service worker`); bad++; }
    }
  }
  if (!bad) pass('lib/pod/ imports nothing above itself and no Node built-ins');
}

// ---- 5. its one dependency stays confined ----
{
  const rdflibbers = podFiles.filter((f) => /from\s+['"]rdflib['"]/.test(code(read(path.join(POD, f)))));
  const allowed = ['transport.mjs', 'notifications.mjs'];
  const extra = rdflibbers.filter((f) => !allowed.includes(f));
  if (extra.length) fail(`rdflib reached from ${extra.join(', ')} — a resource module must not pull a parser in behind it`);
  else pass(`rdflib is confined to ${allowed.join(' and ')}`);

  const importsTransport = podFiles
    .filter((f) => f !== 'transport.mjs')
    .filter((f) => /from\s+['"]\.\/transport\.mjs['"]/.test(code(read(path.join(POD, f)))));
  if (importsTransport.length) fail(`${importsTransport.join(', ')} imports the transport — operations receive one, they do not reach for it`);
  else pass('no resource module imports or constructs a transport');
}

// ---- 6. it does not know what application it grew up in ----
{
  const named = podFiles.filter((f) => /fedipod/i.test(code(read(path.join(POD, f)))));
  if (named.length) fail(`lib/pod/${named.join(', ')} names FediPod in code — the library is meant to outlive it`);
  else pass('no FediPod vocabulary in library code');
}

// ---- 7. and it actually runs on its own ----
{
  const { apUrls } = await import(path.join(POD, 'urls.mjs'));
  const { PodTransport, protectedFromDeletion } = await import(path.join(POD, 'transport.mjs'));
  const urls = apUrls('https://p.example/', 'anything/');
  let threw = false;
  try { apUrls('https://p.example/'); } catch { threw = true; }
  if (!threw) fail('apUrls guessed a container root instead of requiring one');

  const seen = [];
  const pod = new PodTransport(
    { fetch: async (u, i) => { seen.push(`${i?.method || 'GET'} ${u}`); return { status: 200, headers: { get: () => null } }; } },
    { webId: 'https://p.example/profile/card#me', role: 'agent', runtime: 'node' },
  );
  const inbox = await import(path.join(POD, 'inbox.mjs'));
  await inbox.writeKeep(pod, urls);
  await inbox.setPosture(pod, urls, 'open');
  let refused = false;
  try { await pod.delete('https://p.example/profile/card'); } catch { refused = true; }
  if (!refused) fail('the deny-list did not refuse a DELETE of the WebID document');
  if (!seen.some((r) => r.startsWith('PUT https://p.example/anything/ap/inbox/.keep'))) {
    fail(`the inbox operations did not reach the pod as expected: ${seen.join(', ')}`);
  }
  if (pod.label !== 'agent/node') fail(`the transport did not label itself: ${pod.label}`);
  if (typeof protectedFromDeletion !== 'function') fail('protectedFromDeletion is not exported');
  pass('the library imports and runs against a stub with nothing but rdflib on the path');
}

console.log(failures ? `\n${failures} failure(s)` : '\npod layer intact');
process.exit(failures ? 1 : 0);
