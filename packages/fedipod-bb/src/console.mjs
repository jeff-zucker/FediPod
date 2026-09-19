// console.mjs — the forum's own window, on this machine: what it is doing,
// what it is holding, and what it has just said. Loopback only, https like
// every listener this project starts, and behind a key minted per run — the
// queue it shows holds reports and held posts, which are a moderator's to
// read.
//
// It changes nothing. Everything a moderator DOES — letting a post through,
// naming a moderator, renaming a category — is asked for at the website and
// published at the asker's own pod, which is what makes it verifiable. A
// second door here that could act would be a weaker way into the same forum.

import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureTrustedTls } from '../../../lib/device/certs.mjs';
import * as topics from './topics.mjs';

export const DEFAULT_CONSOLE_PORT = 8031;

const esc = (s) => String(s ?? '').replace(/[&<>"]/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

// A handle out of an actor id, for reading: the forum's own ids are the
// Gateway's, so the name is the segment under /u/.
const nameOf = (id) => {
  try {
    const u = new URL(id);
    const at = u.pathname.split('/').filter(Boolean).filter(s => s !== 'ap' && s !== 'actor').pop();
    return `@${at}@${u.host}`;
  } catch { return String(id); }
};

function page(agent, lines) {
  const cfg = agent.config || {};
  const site = agent.site || {};
  const hosting = agent.viewer === false;
  const rows = [];
  for (const cat of agent.categories || []) {
    const held = cat.store.read('modqueue.json', []);
    for (const e of held) {
      rows.push({ cat: cat.slug, type: e.type, by: e.moderator, at: e.at, failed: e.failed || null });
    }
  }
  const cats = (agent.categories || []).map((cat) => ({
    slug: cat.slug,
    name: (cfg.categories || []).find(c => c.slug === cat.slug)?.name || cat.slug,
    topics: topics.list(cat.store).length,
    members: (cat.store.getContacts().followers || []).length,
    closed: (cfg.membersOnly || []).includes(cat.slug),
    waiting: cat.store.read('modqueue.json', []).length,
  }));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(cfg.name || 'Forum')} — this machine</title>
<meta http-equiv="refresh" content="15">
<style>
  :root { color-scheme: light dark; font-size: 125%; }
  body { font-family: Arial, Helvetica, sans-serif; margin: 0 auto; padding: 1rem; max-width: 60rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .2rem; }
  h2 { font-size: 1.1rem; margin: 1.4rem 0 .4rem; }
  .dim { color: #565656; }
  .state { font-weight: 700; }
  .hosting { color: #1f7a3d; }
  .watching { color: #8a4b00; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #b0b0b0; vertical-align: top; }
  th { color: #565656; }
  pre { background: #ececec; padding: .6rem; overflow-x: auto; font-size: .8rem; line-height: 1.35; }
  .err { color: #b00020; }
  @media (prefers-color-scheme: dark) {
    body { background: #191919; color: #f3f3f3; }
    .dim, th { color: #d2d2d2; }
    pre { background: #242526; }
    .hosting { color: #a7d4b5; }
  }
</style></head>
<body>
<h1>${esc(cfg.name || 'Forum')}</h1>
<p class="dim">${esc(cfg.handle || '')} · on ${esc(site.podHome || cfg.remotePod || '')}</p>
<p class="state ${hosting ? 'hosting' : 'watching'}">${hosting ? 'Hosting this forum' : 'Watching — another device holds the lease, or the start has not finished'}</p>

<h2>Categories</h2>
<table><thead><tr><th>Name</th><th>Handle</th><th>Topics</th><th>Members</th><th>Open</th><th>Waiting</th></tr></thead>
<tbody>${cats.map(c => `<tr>
  <td>${esc(c.name)}</td><td>${esc(c.slug)}</td><td>${c.topics}</td><td>${c.members}</td>
  <td>${c.closed ? 'private' : 'open'}</td><td>${c.waiting}</td></tr>`).join('') || '<tr><td colspan="6">none</td></tr>'}
</tbody></table>

<h2>Moderators</h2>
<p>${(cfg.moderators || []).map(m => esc(nameOf(m))).join(', ') || '<span class="dim">nobody</span>'}</p>
<p class="dim">${(cfg.moderatorWebIds || []).length} of them can read the queue.</p>

<h2>Waiting for a moderator</h2>
<table><thead><tr><th>Category</th><th>What</th><th>Who</th><th>Since</th></tr></thead>
<tbody>${rows.map(r => `<tr>
  <td>${esc(r.cat)}</td><td>${esc(r.type)}</td><td>${esc(nameOf(r.by))}</td><td>${esc(when(r.at))}
  ${r.failed ? `<div class="err">did not take: ${esc(r.failed)}</div>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="4">nothing</td></tr>'}
</tbody></table>

<h2>What it has been saying</h2>
<pre>${esc(lines.join('\n')) || 'nothing yet'}</pre>
<p class="dim">This page reads; it changes nothing. Moderating is done at the forum's website.
It refreshes itself every 15 seconds.</p>
</body></html>`;
}

// `agent` is a live ForumAgent; `lines` is a function returning the log ring.
export function startConsole({ agent, lines = () => [], port = DEFAULT_CONSOLE_PORT, home, log = console.log }) {
  const key = crypto.randomBytes(16).toString('hex');
  const tls = ensureTrustedTls(path.join(home, 'certs'), { log: () => {} });
  const handler = (req, res) => {
    const url = new URL(req.url || '/', 'https://localhost');
    // The key is minted per run and printed once: a page holding reports and
    // held posts is not something every process on this machine may read.
    if (url.searchParams.get('k') !== key) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('this console is opened with the address printed when the forum started\n');
      return;
    }
    if (url.pathname !== '/') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no such page\n'); return; }
    let body;
    try { body = page(agent, lines()); } catch (e) { body = `<pre>the console could not read the forum: ${esc(e.message)}</pre>`; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  const servers = [];
  for (const host of ['127.0.0.1', '::1']) {
    const s = https.createServer({ key: tls.key, cert: tls.cert }, handler);
    s.on('error', () => { /* no IPv6 loopback here, or the port is taken */ });
    s.listen(port, host);
    s.unref();
    servers.push(s);
  }
  const at = `https://localhost:${port}/?k=${key}`;
  log(`console: ${at}`);
  return { url: at, stop: () => { for (const s of servers) { try { s.close(); } catch { /* already down */ } } } };
}
