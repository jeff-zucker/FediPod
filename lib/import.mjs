// import.mjs — bring a non-FediPod account's exports in: the CSV files a
// Mastodon-family server hands its leaver (follows, blocks, mutes, lists,
// domain blocks; Misskey's exports are the same shapes). Parsing is here;
// application runs in a paced worker owned by the agent, because most rows
// cost network requests — a handle has to be resolved to its actor before
// anything can be followed, blocked or muted — and a migration-sized list
// applied at full speed is a flood aimed at every server it names.
//
// The state document is shared with stage() and clear(), which run from the
// admin route while a row is in flight — so nothing here holds a copy of it
// across a network await. Every mutation is read-modify-write against a fresh
// read, and a row that finished travelling is committed only if its record is
// still there and still pending.

import crypto from 'node:crypto';
import { lookupWebFinger, selfLink, confirmDelegation, followActor, unfollowActor } from './social.mjs';

export const IMPORT_STATE_DOC = 'import-state.json';
export const IMPORT_KINDS = ['follow', 'block', 'mute', 'list', 'domain'];

const TICK_MS = 400;          // one network row per tick at most
const FOLLOW_GAP_MS = 1000;   // follows also deliver, so they go slower
const PUBLISH_EVERY = 25;     // follows between collection republishes
const MAX_ROWS = 25_000;      // staged-row cap: the doc is rewritten per row

// A real CSV parse — quoted fields, doubled quotes, CRLF — because a list
// title may contain a comma and a display name may contain anything.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); if (row.some(f => f !== '')) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') endField();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else field += c;
  }
  endRow();
  return rows;
}

const HANDLE = /^[^@\s]+@[^@\s]+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const cleanHandle = (s) => String(s || '').trim().replace(/^@/, '');

// CSV text → normalized row values for one kind. Header and comment rows are
// recognized only where they can exist — a LIST title is free text and may
// legitimately start with '#' or say anything. Invalid rows come back counted,
// with the first few quoted so a mis-picked file is obvious.
export function normalizeImport(kind, text) {
  if (!IMPORT_KINDS.includes(kind)) throw new Error(`unknown import kind: ${kind}`);
  const rows = parseCsv(String(text || ''));
  const values = [];
  const invalid = [];
  for (const cols of rows) {
    const first = String(cols[0] || '').trim();
    if (!first) continue;
    if (kind !== 'list' && /^#/.test(first)) continue;                          // comment
    if (kind !== 'list' && kind !== 'domain' && /account address/i.test(first)) continue;  // header
    if (kind === 'domain') {
      const d = first.toLowerCase();
      if (DOMAIN.test(d)) values.push(d); else invalid.push(first);
    } else if (kind === 'list') {
      const handle = cleanHandle(cols[1]);
      if (first && HANDLE.test(handle)) values.push({ value: handle, list: first });
      else invalid.push(cols.join(','));
    } else {
      const handle = cleanHandle(first);
      if (HANDLE.test(handle)) values.push(handle); else invalid.push(first);
    }
  }
  return { values, invalid };
}

// The paced applier. One instance per agent, armed only while the agent is
// active — startActive/requestTakeover resume it, demote stops it — and each
// tick re-checks the lease and the pod's backoff before touching anything.
export class ImportWorker {
  constructor({ agent, log }) {
    this.agent = agent;
    this.log = log || (() => {});
    this.timer = null;
    this.busy = false;
    this.lastFollowAt = 0;
  }

  state() { return this.agent.store.read(IMPORT_STATE_DOC, null); }

  // Add parsed rows to the run. Rows already staged, already applied, or
  // already following are counted out rather than re-queued, so re-running
  // the same file is a no-op. The cap keeps the per-row rewrite bounded.
  stage(kind, values) {
    const agent = this.agent;
    const st = this.state() || { startedAt: new Date().toISOString(), rows: [] };
    delete st.completedAt;                     // a new batch reopens the run
    const key = (r) => [r.kind, r.list || '', r.value].join(' ');
    const have = new Set(st.rows.map(key));
    const following = new Set(agent.store.getContacts().following.map(f => f.handle).filter(Boolean));
    const domains = new Set(agent.store.getBlocklist().domains);
    let staged = 0, duplicate = 0, already = 0, refused = 0;
    for (const v of values) {
      const row = typeof v === 'string' ? { kind, value: v } : { kind, ...v };
      row.status = 'pending';
      if (have.has(key(row))) { duplicate++; continue; }
      if (kind === 'follow' && following.has(row.value)) { already++; continue; }
      if (kind === 'domain' && domains.has(row.value)) { already++; continue; }
      if (st.rows.length >= MAX_ROWS) { refused++; continue; }
      have.add(key(row));
      st.rows.push(row);
      staged++;
    }
    agent.store.write(IMPORT_STATE_DOC, st);
    if (staged) this.start();
    return { staged, duplicate, already, refused, total: st.rows.length };
  }

  progress() {
    const st = this.state();
    const prior = st?.doneCount || 0;
    if (!st?.rows?.length && !prior) return { rows: 0, pending: 0, done: 0, failed: 0, running: !!this.timer };
    const byKind = {};
    let pending = 0, done = prior, failed = 0;
    for (const r of st.rows) {
      const k = (byKind[r.kind] ||= { pending: 0, done: 0, failed: 0 });
      k[r.status]++;
      if (r.status === 'pending') pending++;
      else if (r.status === 'done') done++;
      else failed++;
    }
    return {
      rows: st.rows.length + prior, pending, done, failed, byKind,
      running: !!this.timer, startedAt: st.startedAt, completedAt: st.completedAt || null,
      failures: st.rows.filter(r => r.status === 'failed').slice(0, 100)
        .map(r => ({ kind: r.kind, value: r.value, ...(r.list ? { list: r.list } : {}), reason: r.reason })),
    };
  }

  clear() {
    this.stop();
    this.agent.store.write(IMPORT_STATE_DOC, { rows: [] });
  }

  // Called from startActive and after a takeover: pick a stranded run back
  // up. Any unclosed run arms the timer — rows still pending, or a final
  // publish that never landed.
  resume() {
    const st = this.state();
    if (!st?.rows?.length || st.completedAt) return;
    this.start();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(e => this.log(`import tick: ${e.message}`)), TICK_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const agent = this.agent;
      const st = this.state();
      if (!st?.rows) { this.stop(); return; }
      // A parked or moved actor runs no import: parking mass-unfollows and a
      // move hands the account on — the worker must not pull against either.
      const cfg = agent.store.getConfig?.() || {};
      if (cfg?.quiescedAt || cfg?.movedTo) { this.stop(); return; }
      const next = st.rows.find(r => r.status === 'pending');
      if (!next) {
        if (!st.completedAt) await this.finish();
        else this.stop();
        return;
      }
      if (agent.viewer) return;                                  // demoted mid-run
      if (agent.lease && !agent.lease.stillHeld()) return;       // another device is acting
      if (agent.remote?.pausedUntil > Date.now()) return;        // the pod asked for quiet
      if (next.kind === 'follow' && Date.now() - this.lastFollowAt < FOLLOW_GAP_MS) return;
      if (next.kind === 'domain') {
        // Free rows — no resolution, no delivery — the whole batch lands in
        // one tick. No awaits between the read and the write, so no race.
        const b = agent.store.getBlocklist();
        const fresh = this.state();
        if (!fresh?.rows) return;
        for (const r of fresh.rows) {
          if (r.status !== 'pending' || r.kind !== 'domain') continue;
          if (!b.domains.includes(r.value)) b.domains.push(r.value);
          r.status = 'done';
        }
        agent.store.setBlocklist(b);
        agent.store.write(IMPORT_STATE_DOC, fresh);
        return;
      }
      // The network happens here, touching no state document; the verdict is
      // committed against a FRESH read afterwards, so rows staged or cleared
      // while this one travelled are never overwritten.
      const outcome = await this.applyRow(next);
      if (outcome) this.commitRow(next, outcome);
      if (outcome?.followed && (this.state()?.followsSincePublish || 0) >= PUBLISH_EVERY) {
        await agent.publisher.publishCollections({ following: true, pending: true });
        const after = this.state();
        if (after) { after.followsSincePublish = 0; agent.store.write(IMPORT_STATE_DOC, after); }
      }
    } finally { this.busy = false; }
  }

  // Record one travelled row's verdict. Fresh read; the row is matched by
  // content — if clear() dropped it or a duplicate check superseded it while
  // it was in flight, there is nothing to record and nothing is written.
  commitRow(row, outcome) {
    const st = this.state();
    const match = st?.rows?.find(r => r.status === 'pending' && r.kind === row.kind
      && r.value === row.value && (r.list || '') === (row.list || ''));
    if (!match) return;
    match.status = outcome.status;
    if (outcome.reason) match.reason = outcome.reason;
    if (outcome.followed) st.followsSincePublish = (st.followsSincePublish || 0) + 1;
    if (outcome.blocked) st.blocksApplied = true;
    this.agent.store.write(IMPORT_STATE_DOC, st);
  }

  // handle → { id, inbox } — the lean resolve: WebFinger, one actor fetch,
  // the delegation round-trip, and nothing else. A handle we already follow
  // answers from contacts without touching the network, and the blocklist is
  // honored the same way the interactive resolve honors it.
  async resolve(clean, { forBlock = false } = {}) {
    const agent = this.agent;
    const host = clean.slice(clean.lastIndexOf('@') + 1);
    if (agent.store.isBlocked(`https://${host}/`)) throw new Error('domain is blocked');
    const known = agent.store.getContacts().following.find(f => f.handle === clean && f.actor);
    if (known) return { id: known.actor, inbox: known.inbox };
    const jrd = await lookupWebFinger('acct:' + clean);
    const href = selfLink(jrd)?.href;
    if (!href) throw new Error('webfinger found no actor');
    const doc = await agent.intake.fetchAP(href);
    if (!doc?.id) throw new Error('actor document unusable');
    if (!forBlock && agent.store.isBlocked(doc.id)) throw new Error('actor is blocked');
    await confirmDelegation(clean.slice(clean.lastIndexOf('@') + 1), doc);
    return doc;
  }

  // One row's whole journey, returned as a verdict — never written here.
  // null means "no verdict": the pod's backoff interrupted it, and the row
  // stays pending for after the pause.
  async applyRow(row) {
    const agent = this.agent;
    const done = (extra = {}) => ({ status: 'done', ...extra });
    try {
      if (row.kind === 'follow') {
        this.lastFollowAt = Date.now();
        if (agent.store.getContacts().following.some(f => f.handle === row.value)) {
          return done({ reason: 'already following' });
        }
        const doc = await this.resolve(row.value);
        if (agent.store.getContacts().following.some(f => f.actor === doc.id)) {
          return done({ reason: 'already following' });
        }
        // followActor records the contact BEFORE delivering, which is what
        // lets the Accept that comes back seconds later find its record.
        await followActor(agent, doc.id, { publish: false, doc });
        const contacts = agent.store.getContacts();
        const rec = contacts.following.find(f => f.actor === doc.id);
        if (rec && !rec.handle) { rec.handle = row.value; agent.store.setContacts(contacts); }
        return done({ followed: true });
      }
      if (row.kind === 'block') {
        const host = row.value.slice(row.value.lastIndexOf('@') + 1);
        const b = agent.store.getBlocklist();
        if (b.domains.some(d => host === d || host.endsWith('.' + d))) {
          return done({ reason: 'domain already blocked' });
        }
        const doc = await this.resolve(row.value, { forBlock: true });
        const b2 = agent.store.getBlocklist();
        if (b2.actors.includes(doc.id)) return done({ reason: 'already blocked' });
        b2.actors.push(doc.id);
        agent.store.setBlocklist(b2);
        if (agent.store.getContacts().following.some(f => f.actor === doc.id)) {
          await unfollowActor(agent, doc.id).catch(() => {});
        }
        return done({ blocked: true });
      }
      if (row.kind === 'mute') {
        const doc = await this.resolve(row.value);
        const m = agent.store.getMuted();
        if (m.actors.includes(doc.id)) return done({ reason: 'already muted' });
        m.actors.push(doc.id);
        agent.store.setMuted(m);
        return done();
      }
      if (row.kind === 'list') {
        const doc = await this.resolve(row.value);
        const lists = agent.store.getLists();
        let l = lists.find(x => x.title === row.list);
        if (!l) {
          l = { id: crypto.randomBytes(8).toString('hex'), title: row.list, repliesPolicy: 'list', members: [] };
          lists.push(l);
        }
        if ((l.members || []).includes(doc.id)) return done({ reason: 'already on the list' });
        l.members = [...(l.members || []), doc.id];
        agent.store.setLists(lists);
        return done();
      }
      return { status: 'failed', reason: `unknown kind ${row.kind}` };
    } catch (e) {
      if (agent.remote?.pausedUntil > Date.now()) return null;
      return { status: 'failed', reason: e.message };
    }
  }

  // Everything applied: the batched republishes, once, then the record closes
  // — done rows pruned to a count so a long run's record stays small, failed
  // rows kept until --clear so they can be read. A publish the pod refuses
  // leaves the run open; a restart or the next batch retries it. A batch that
  // landed while the publishes were in flight keeps the run open too.
  async finish() {
    const agent = this.agent;
    let st = this.state();
    if (!st?.rows) { this.stop(); return; }
    if (st.rows.some(r => r.status === 'pending')) return;
    try {
      if (st.followsSincePublish) {
        await agent.publisher.publishCollections({ following: true, pending: true });
        const s = this.state();
        if (s) { s.followsSincePublish = 0; agent.store.write(IMPORT_STATE_DOC, s); }
      }
      if (this.state()?.blocksApplied) {
        await agent.publisher.publishCollections({ blocked: true });
        const s = this.state();
        if (s) { s.blocksApplied = false; agent.store.write(IMPORT_STATE_DOC, s); }
      }
    } catch (e) {
      this.log(`import: final publish failed: ${e.message} — retried on restart or the next batch`);
      this.stop();
      return;
    }
    st = this.state();
    if (!st?.rows || st.rows.some(r => r.status === 'pending')) return;
    const doneNow = st.rows.filter(r => r.status === 'done').length;
    const failed = st.rows.filter(r => r.status === 'failed').length;
    st.doneCount = (st.doneCount || 0) + doneNow;
    st.rows = st.rows.filter(r => r.status !== 'done');
    st.completedAt = new Date().toISOString();
    agent.store.write(IMPORT_STATE_DOC, st);
    this.log(`import finished: ${st.doneCount} applied, ${failed} failed`);
    this.stop();
  }
}
