// fedi-account.mjs — type a Fediverse handle or a WebID, and get back an
// account you can act with: post, read its timeline, follow, reply,
// favourite, boost. The library works out whether the account lives on a
// Mastodon-family server or on a Solid pod through FediPod, and speaks to
// whichever it is. The app never has to know which it got.
//
//   import { fediAccount } from './fedi-account.mjs';
//   const accounts = fediAccount({ dbName: 'my-app', clientName: 'My app' });
//
//   await accounts.resume();                        // on every page load
//   await accounts.login('@kwame@mastodon.social'); // or '@mei@fedipod.net', or a WebID
//   const me = await accounts.current();            // null, or the account below
//
//   me.handle, me.kind ('mastodon' | 'pod'), me.notice (a sentence to show, or null)
//   await me.post({ text });            await me.timeline({ limit: 20 })
//   await me.reply(postUrlOrId, text);  await me.follow('@aisha@her.server')
//   await me.favourite(postUrlOrId);    await me.boost(postUrlOrId)
//   await me.outbox({ limit: 20 });     // this account's own posts, newest first
//   await me.outbox({ rdf: true });     // the same, plus the real RDF graph on .rdf
//   await me.signOut()
//
// A Mastodon account is used through its server's API with a token the
// person granted this app; the token stays in this browser. A pod account
// is used through its FediPod outbox door with the person's pod sign-in:
// what is posted there is carried out by the account's own agent. When that
// agent is a browser at fedipod.net, the account carries a notice saying so.
//
// No imports but the two files beside it, no Node built-ins, nothing named
// after the application that uses it.
import { fediLogin, parseAddress } from './fedi-login.mjs';

const AS = 'https://www.w3.org/ns/activitystreams';
const PUBLIC = `${AS}#Public`;
const AS_OUTBOX = `${AS}#outbox`;
const FOAF_ACCOUNT = 'http://xmlns.com/foaf/0.1/account';
const DEFAULT_SCOPES = 'read write follow';
const PENDING_TTL_MS = 10 * 60_000;

export const BROWSER_ACCOUNT_NOTICE = 'Because you have a browser-based account, your posts and interactions will only go out to the Fediverse when your browser is opened to your account.';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toHtml = (text) => `<p>${esc(text).replace(/\r?\n/g, '<br>')}</p>`;
const memoryStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

export function fediAccount({
  dbName = 'fediverse-account', clientName = 'Fediverse app', redirectUri = null, scopes = DEFAULT_SCOPES,
  website = null, fetch: f = globalThis.fetch?.bind(globalThis), storage = globalThis.localStorage || memoryStorage(),
} = {}) {
  const pod = fediLogin({ dbName, clientName, redirectUri, fetch: f });
  const here = () => (globalThis.location ? location.origin + location.pathname : null);
  const key = (k) => `${dbName}:${k}`;
  const read = (k) => { try { return JSON.parse(storage.getItem(key(k)) || 'null'); } catch { return null; } };
  const write = (k, v) => storage.setItem(key(k), JSON.stringify(v));
  const drop = (k) => storage.removeItem(key(k));
  const json = (url, init = {}) => f(url, { ...init, headers: { accept: 'application/json', ...(init.headers || {}) } })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const said = async (res, host) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error_description || body.error || `${host} answered ${res.status}`);
    return body;
  };

  // A collection, or a page of one, may be named by its address or given
  // whole in place (ActivityPub allows either); the whole one is used as it
  // is, an address is fetched.
  const idOf = (v) => (typeof v === 'string' ? v : v?.id || null);
  const asDoc = async (v) => (v && typeof v === 'object'
    ? (v.type ? v : await asDoc(v.id))
    : (typeof v === 'string' ? await json(v, { headers: { accept: 'application/activity+json' } }) : null));

  // Only loaded when `outbox({ rdf: true })` is actually called, so nobody
  // pays for a JSON-LD parser just by importing this file. Not in
  // `dependencies` — the app supplies "jsonld" if it wants this flag to work.
  const loadJsonLd = async () => {
    try { return (await import('jsonld')).default; }
    catch { throw new Error('outbox({ rdf: true }) needs the "jsonld" package available to the app — it is not bundled with this library'); }
  };

  // The account's real outbox, read from the pod: the head collection names
  // `first`, each page names `orderedItems` and (while there is more) `next`.
  // Walked only far enough to cover `limit`, and run through jsonld.toRDF so
  // the result is a genuine RDF/JS quad array, not this library's own shape.
  const fetchOutboxRdf = async (actorUrl, limit) => {
    if (!actorUrl) return null;
    const jsonld = await loadJsonLd();
    const actorDoc = await json(actorUrl, { headers: { accept: 'application/activity+json' } });
    const head = await asDoc(actorDoc?.outbox);
    let page = head?.first ?? null;
    const quads = []; const seen = new Set(); let collected = 0;
    while (page && collected < limit && !seen.has(idOf(page) || page)) {
      seen.add(idOf(page) || page);
      const doc = await asDoc(page);
      if (!doc) break;
      quads.push(...(await jsonld.toRDF(doc)));
      collected += (doc.orderedItems || []).length;
      page = doc.next ?? null;
    }
    return quads;
  };

  // ---- finding out what an address is ----

  // Does this host speak the Mastodon API? Any server of that family says so
  // here; a pod, a Gateway and a plain web host do not.
  const speaksMastodon = async (host) => {
    const inst = await json(`https://${host}/api/v1/instance`);
    return !!(inst && (inst.uri || inst.domain || inst.title));
  };

  const webfinger = async (name, host) => {
    const jrd = await json(`https://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${name}@${host}`)}`,
      { headers: { accept: 'application/jrd+json, application/json' } });
    if (!jrd) throw new Error(`${host} does not know @${name}@${host}`);
    const self = (jrd.links || []).find((l) => l.rel === 'self' && /activity\+json|ld\+json/u.test(l.type || ''));
    return { actor: self?.href || null, aliases: (jrd.aliases || []).filter((u) => typeof u === 'string') };
  };

  // Where a pod account keeps its records: the actor on the pod itself is
  // `<root>ap/actor`, and the aliases name it even when the address is at a
  // Gateway.
  const rootOf = (actor, aliases) => {
    const onPod = [...aliases, actor].find((u) => typeof u === 'string' && /\/ap\/actor$/u.test(u) && (!actor || new URL(u).origin !== new URL(actor).origin))
      || [...aliases, actor].find((u) => typeof u === 'string' && /\/ap\/actor$/u.test(u));
    return onPod ? onPod.replace(/ap\/actor$/u, '') : null;
  };

  /** What an address is, without signing in: { kind: 'mastodon' | 'pod', host, handle, actor, … }. */
  async function describe(address) {
    const a = parseAddress(address);
    if (!a) throw new Error('an address looks like @you@your.server, or is your WebID');
    if (a.url) {
      // A WebID: the account it names leads to the handle, and the handle to
      // everything else.
      const card = await json(a.url, { headers: { accept: 'application/ld+json' } });
      const nodes = Array.isArray(card) ? card : (card?.['@graph'] || (card ? [card] : []));
      const me = nodes.find((n) => n?.['@id'] === a.url) || {};
      const actorId = [].concat(me[FOAF_ACCOUNT] || []).map((v) => v?.['@id'] || v).find((v) => typeof v === 'string');
      if (!actorId) throw new Error(`${a.host} names no Fediverse account on that WebID`);
      const actor = await json(actorId, { headers: { accept: 'application/activity+json' } });
      if (!actor?.preferredUsername) throw new Error(`the account ${actorId} could not be read`);
      return describe(`@${actor.preferredUsername}@${new URL(actorId).host}`);
    }
    const { actor, aliases } = await webfinger(a.name, a.host);
    const actorHost = actor ? new URL(actor).host : a.host;
    for (const host of [...new Set([actorHost, a.host])]) {
      if (await speaksMastodon(host)) return { kind: 'mastodon', host, handle: a.at, actor };
    }
    const where = await pod.resolve(a.at);
    return { kind: 'pod', host: a.host, handle: a.at, actor: actor || where.actor, issuer: where.issuer, root: rootOf(actor || where.actor, aliases) };
  }

  // ---- signing in ----

  const appFor = async (host, ru) => {
    const apps = read('masto:apps') || {};
    const known = apps[host];
    if (known?.redirectUri === ru && known.clientId) return known;
    const res = await f(`https://${host}/api/v1/apps`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: clientName, redirect_uris: ru, scopes, ...(website ? { website } : {}) }),
    });
    const body = await said(res, host);
    if (!body.client_id) throw new Error(`${host} registered no client`);
    const app = { host, redirectUri: ru, clientId: body.client_id, clientSecret: body.client_secret || null };
    write('masto:apps', { ...apps, [host]: app });
    return app;
  };

  /** Everything `login` does short of leaving the page: what the address is and the page to send the person to. */
  async function startLogin(address, { returnTo = globalThis.location?.href || null, redirectUri: ru = redirectUri || here() } = {}) {
    const what = await describe(address);
    if (what.kind === 'pod') {
      const s = await pod.startLogin(what.handle, { returnTo, redirectUri: ru });
      write('pod:pending', { handle: what.handle, actor: what.actor, root: what.root, at: Date.now() });
      return { ...what, authorizationUrl: s.authorizationUrl, returnTo };
    }
    const app = await appFor(what.host, ru);
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const state = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    write('masto:pending', { state, host: what.host, redirectUri: ru, returnTo, at: Date.now() });
    const u = new URL(`https://${what.host}/oauth/authorize`);
    for (const [k, v] of Object.entries({ client_id: app.clientId, redirect_uri: ru, response_type: 'code', scope: scopes, state })) u.searchParams.set(k, v);
    return { ...what, authorizationUrl: u.href, returnTo };
  }

  /** Send the person to wherever this account signs in. They come back to this
   *  page (unless `redirectUri` says otherwise) and `resume` returns them to
   *  where they were (unless `returnTo` says otherwise). */
  async function login(address, opts) {
    const s = await startLogin(address, opts);
    location.href = s.authorizationUrl;
    return s;
  }

  /** Call on every page load. Finishes a sign-in the person is coming back
   *  from, of either kind, and returns them to where they were. Returns the
   *  account, or null when nobody is coming back. */
  async function resume({ currentUrl = globalThis.location?.href, go = (u) => location.replace(u) } = {}) {
    const u = new URL(currentUrl);
    const code = u.searchParams.get('code'); const state = u.searchParams.get('state');
    const pend = read('masto:pending');
    if (code && state && pend?.state === state) {
      drop('masto:pending');
      if (Date.now() - pend.at > PENDING_TTL_MS) throw new Error('that sign-in has expired — start again');
      const app = await appFor(pend.host, pend.redirectUri);
      const tok = await said(await f(`https://${pend.host}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: pend.redirectUri, client_id: app.clientId, ...(app.clientSecret ? { client_secret: app.clientSecret } : {}), scope: scopes }),
      }), pend.host);
      if (!tok.access_token) throw new Error(`${pend.host} returned no token`);
      const me = await said(await f(`https://${pend.host}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${tok.access_token}` } }), pend.host);
      write('masto:account', { host: pend.host, token: tok.access_token, handle: `@${me.username}@${pend.host}`, name: me.display_name || me.username, actor: me.url || me.uri || null });
      drop('pod:facts');
      if (pend.returnTo && pend.returnTo !== currentUrl) go(pend.returnTo);
      return current();
    }
    const session = await pod.resume({ currentUrl, go: () => {} });
    if (!session) return null;
    const p = read('pod:pending') || {};
    drop('pod:pending');
    const facts = await podFacts(session, p);
    write('pod:facts', facts);
    drop('masto:account');
    if (session.returnTo && session.returnTo !== currentUrl) go(session.returnTo);
    return current();
  }

  // What a pod account needs, found once at sign-in: its door, its records,
  // its followers collection, and whether its agent is a browser.
  const podFacts = async (session, p) => {
    const card = await json(session.webId, { headers: { accept: 'application/ld+json' } });
    const nodes = Array.isArray(card) ? card : (card?.['@graph'] || (card ? [card] : []));
    const me = nodes.find((n) => n?.['@id'] === session.webId) || {};
    const pick = (node, k) => [].concat(node?.[k] || []).map((v) => v?.['@id'] || v).find((v) => typeof v === 'string') || null;
    let actor = p.actor || pick(me, FOAF_ACCOUNT);
    let door = pick(me, AS_OUTBOX);
    const doc = actor ? await json(actor, { headers: { accept: 'application/activity+json' } }) : null;
    if (!door && doc?.outbox) door = idOf(doc.outbox);
    let root = p.root || null;
    if (!root && doc?.preferredUsername && actor) {
      const { aliases } = await webfinger(doc.preferredUsername, new URL(actor).host).catch(() => ({ aliases: [] }));
      root = rootOf(actor, aliases);
    }
    const handle = p.handle || (doc?.preferredUsername && actor ? `@${doc.preferredUsername}@${new URL(actor).host}` : null);
    // A browser-made account keeps its signing key on the pod sealed under
    // the password; a device keeps its key with itself. The shape says which.
    let browserBased = false;
    if (root) {
      const keys = await session.fetch(`${root}ap-state/keys.json`, { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const envelope = keys && (keys.v === 1 && typeof keys.ct === 'string' && typeof keys.salt === 'string'
        || Object.values(keys).some((k) => k && k.v === 1 && typeof k.ct === 'string' && typeof k.salt === 'string'));
      browserBased = !!envelope;
    }
    return { handle, actor, name: doc?.name || null, door, root, followers: doc?.followers || null, webId: session.webId, browserBased };
  };

  // ---- the account ----

  const mastodonAccount = (a) => {
    const base = `https://${a.host}`;
    const auth = { authorization: `Bearer ${a.token}` };
    const call = (path, init = {}) => f(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers || {}) } });
    const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => said(r, a.host));
    // A post named by its address is found on this server by a search that
    // fetches it if need be; one named by an id here is used as it is.
    const idOf = async (target) => {
      if (!/^https?:\/\//u.test(String(target))) return String(target);
      const u = new URL(`${base}/api/v2/search`);
      u.searchParams.set('q', target); u.searchParams.set('resolve', 'true'); u.searchParams.set('type', 'statuses'); u.searchParams.set('limit', '1');
      const body = await call(u.href).then((r) => said(r, a.host));
      const id = body.statuses?.[0]?.id;
      if (!id) throw new Error(`${a.host} could not find that post`);
      return id;
    };
    const item = (s) => ({
      id: s.id, url: s.url || s.uri || null, published: s.created_at,
      author: { id: s.account?.url || null, handle: s.account?.acct ? `@${s.account.acct}${s.account.acct.includes('@') ? '' : '@' + a.host}` : null, name: s.account?.display_name || s.account?.username || null },
      html: s.content || '', inReplyTo: s.in_reply_to_id || null,
      ...(s.reblog ? { boostOf: item(s.reblog) } : {}),
    });
    return {
      kind: 'mastodon', handle: a.handle, name: a.name, actor: a.actor, notice: null,
      fetch: call,
      async profile() {
        const me = await call('/api/v1/accounts/verify_credentials').then((r) => said(r, a.host));
        return { handle: a.handle, name: me.display_name || me.username || null, url: me.url || null, avatar: me.avatar || null, bio: me.note || '',
          followers: me.followers_count ?? null, following: me.following_count ?? null, posts: me.statuses_count ?? null, actor: a.actor, webId: null };
      },
      async post({ text, inReplyTo = null, visibility = 'public' }) {
        const made = await post('/api/v1/statuses', { status: text, visibility, ...(inReplyTo ? { in_reply_to_id: await idOf(inReplyTo) } : {}) });
        return { id: made.id, url: made.url || made.uri || null, sent: true };
      },
      reply(target, text) { return this.post({ text, inReplyTo: target }); },
      async timeline({ limit = 20 } = {}) {
        const list = await call(`/api/v1/timelines/home?limit=${Math.min(40, limit)}`).then((r) => said(r, a.host));
        return (Array.isArray(list) ? list : []).map(item);
      },
      // This account's own posts, newest first — Mastodon's equivalent of an
      // outbox. A Mastodon server IS an ActivityPub server, so its actor and
      // outbox are real AS2/JSON-LD too, same as a pod's; `rdf: true` reads
      // that, not the REST API above. It comes back empty on an instance that
      // requires a signed request just to read the public actor document
      // (some do — mastodon.social among them); `fetchOutboxRdf`'s plain GET
      // then gets 401 and the loop below finds nothing to walk.
      async outbox({ limit = 20, rdf = false } = {}) {
        const me = await call('/api/v1/accounts/verify_credentials').then((r) => said(r, a.host));
        const list = await call(`/api/v1/accounts/${me.id}/statuses?limit=${Math.min(40, limit)}`).then((r) => said(r, a.host));
        const items = (Array.isArray(list) ? list : []).map(item);
        if (rdf) items.rdf = await fetchOutboxRdf(a.actor, limit);
        return items;
      },
      async follow(handle) {
        const who = parseAddress(handle);
        if (!who?.at) throw new Error('a handle looks like @you@your.server');
        const acct = await call(`/api/v1/accounts/lookup?acct=${encodeURIComponent(who.at.slice(1))}`).then((r) => said(r, a.host));
        if (!acct.id) throw new Error(`${a.host} could not find ${who.at}`);
        await post(`/api/v1/accounts/${acct.id}/follow`);
        return { followed: who.at, sent: true };
      },
      async favourite(target) { await post(`/api/v1/statuses/${await idOf(target)}/favourite`); return { sent: true }; },
      async boost(target) { await post(`/api/v1/statuses/${await idOf(target)}/reblog`); return { sent: true }; },
      async signOut() {
        const apps = read('masto:apps') || {};
        const app = apps[a.host];
        if (app) {
          try { await f(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, token: a.token }) }); } catch { /* told if we could */ }
        }
        drop('masto:account');
      },
    };
  };

  const podAccount = (session, facts) => {
    const knock = async (activity) => {
      if (!facts.door) throw new Error('this account names no outbox to post through');
      const res = await session.fetch(facts.door, { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify({ '@context': AS, ...activity }) });
      if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`the outbox refused it (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`); }
      return { id: res.headers.get('location') || null, sent: res.status === 201, queued: res.status === 202 };
    };
    const audience = (visibility) => {
      if (visibility === 'unlisted') return { to: facts.followers ? [facts.followers] : [], cc: [PUBLIC] };
      if (visibility === 'private' || visibility === 'followers') return { to: facts.followers ? [facts.followers] : [], cc: [] };
      return { to: [PUBLIC], cc: facts.followers ? [facts.followers] : [] };
    };
    const state = (name) => (facts.root ? session.fetch(`${facts.root}ap-state/${name}`, { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null));
    return {
      kind: 'pod', handle: facts.handle, name: facts.name, actor: facts.actor, webId: facts.webId,
      notice: facts.browserBased ? BROWSER_ACCOUNT_NOTICE : null,
      fetch: session.fetch,
      async profile() {
        const doc = facts.actor ? await json(facts.actor, { headers: { accept: 'application/activity+json' } }) : null;
        const count = async (v) => (await asDoc(v))?.totalItems ?? null;
        return { handle: facts.handle, name: doc?.name || null, url: doc?.url || null, avatar: doc?.icon?.url || (typeof doc?.icon === 'string' ? doc.icon : null), bio: doc?.summary || '',
          followers: await count(doc?.followers), following: await count(doc?.following), posts: await count(doc?.outbox), actor: facts.actor, webId: facts.webId };
      },
      async post({ text, inReplyTo = null, visibility = 'public' }) {
        const made = await knock({ type: 'Note', content: toHtml(text), source: { content: text, mediaType: 'text/plain' }, ...(inReplyTo ? { inReplyTo } : {}), ...audience(visibility) });
        return { id: made.id, url: made.id, sent: made.sent, queued: made.queued };
      },
      reply(target, text) { return this.post({ text, inReplyTo: target }); },
      async timeline({ limit = 20 } = {}) {
        const rows = await state('statuses.json');
        const actors = (await state('actors.json')) || {};
        const who = (id) => { const d = actors[id]?.doc || actors[id] || {}; return { id, handle: d.preferredUsername ? `@${d.preferredUsername}@${new URL(id).host}` : null, name: d.name || null }; };
        return (Array.isArray(rows) ? rows : [])
          .filter((s) => s.kind !== 'remote' && s.kind !== 'mention' && !s.direct && s.visibility !== 'direct')
          .sort((x, y) => String(y.published || '').localeCompare(String(x.published || '')))
          .slice(0, limit)
          .map((s) => ({ id: s.noteId, url: s.noteId, published: s.published || null, author: who(s.actor), html: s.content || '', inReplyTo: s.inReplyTo || null }));
      },
      // This account's own posts, newest first, read from the same local
      // record `timeline` uses (fast, no network call). With `rdf: true`,
      // also fetches the real outbox from the pod and parses it into RDF/JS
      // quads on the returned array's `.rdf` — a second, live document, not
      // derived from the local record, so it needs `jsonld` (see loadJsonLd).
      async outbox({ limit = 20, rdf = false } = {}) {
        const rows = await state('statuses.json');
        const actors = (await state('actors.json')) || {};
        const who = (id) => { const d = actors[id]?.doc || actors[id] || {}; return { id, handle: d.preferredUsername ? `@${d.preferredUsername}@${new URL(id).host}` : null, name: d.name || null }; };
        const items = (Array.isArray(rows) ? rows : [])
          .filter((s) => s.kind === 'post')
          .sort((x, y) => String(y.published || '').localeCompare(String(x.published || '')))
          .slice(0, limit)
          .map((s) => ({ id: s.noteId, url: s.noteId, published: s.published || null, author: who(s.actor), html: s.content || '', inReplyTo: s.inReplyTo || null }));
        if (rdf) items.rdf = await fetchOutboxRdf(facts.actor, limit);
        return items;
      },
      async follow(handle) {
        const who = parseAddress(handle);
        if (!who?.at) throw new Error('a handle looks like @you@your.server');
        const made = await knock({ type: 'Follow', object: who.at });
        return { followed: who.at, sent: made.sent, queued: made.queued };
      },
      async favourite(target) { return knock({ type: 'Like', object: target }); },
      async boost(target) { return knock({ type: 'Announce', object: target, ...audience('public') }); },
      async signOut() { await session.signOut(); drop('pod:facts'); },
    };
  };

  /** The signed-in account, or null. */
  async function current() {
    const m = read('masto:account');
    if (m) return mastodonAccount(m);
    const session = await pod.getSession();
    if (!session) return null;
    let facts = read('pod:facts');
    if (!facts || facts.webId !== session.webId) { facts = await podFacts(session, {}); write('pod:facts', facts); }
    return podAccount(session, facts);
  }

  async function signOut() { const me = await current(); if (me) await me.signOut(); }

  // For a test that hands in a pod session of its own.
  const _podAccount = async (session, pending = {}) => podAccount(session, await podFacts(session, pending));

  return { describe, startLogin, login, resume, current, signOut, _podAccount };
}
