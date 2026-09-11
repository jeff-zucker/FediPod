// admin-facade.mjs — the owner's record/manage surface, answered in the browser.
//
// The Node agent serves web/admin over lib/admin.mjs (buildAdminSurface), which
// is Node through and through — filesystem static serving, process control,
// multi-actor, group moderation. The browser reuses the SAME web/admin pages
// (staged static by Netlify) but cannot run that handler: it needs fs, http,
// child_process. So this answers the DATA endpoints those pages call, for the
// one thing a browser identity is: a single, personal, embedded actor.
//
// Personal only. Everything group (joins, members, moderation, mute) or local
// (drain, profiles-of-siblings, start/stop, state-move, update) is either 404
// here or hidden by the page on kind:'person'. What remains is reading and
// editing your own identity: status, config, gateway, alias, key rotation.
//
// It mirrors lib/admin.mjs's handlers for those paths, calling the same agent
// objects (store, publisher, intake, deliverer, remote) the Node agent does.
import { publicHandle, webfingerHost } from '../../lib/core/wire.mjs';
import * as podInbox from '../../lib/pod/inbox.mjs';
import { normalizeImport, IMPORT_KINDS } from '../../lib/connections/import.mjs';
import { hashPassword } from '../../lib/client/mastoapi.mjs';

// The identity itself — changing any means a different actor, i.e. a new setup.
const PERMANENT_CONFIG = ['handle', 'remotePod', 'issuer', 'root', 'kind'];
// Carried in the actor document, so a change is not live until republished.
const WIRE_CONFIG = ['name', 'summary', 'icon', 'image', 'fields', 'aliases'];

// The data endpoints this agent answers at the origin root (the page computes
// its base as the origin, so it asks for /status, not /admin/status). Anything
// not here falls through to the network as a static file or the gateway.
export const ADMIN_PATHS = new Set([
  '/status', '/config', '/gateway', '/alias', '/rotate-key', '/import',
  '/deadletter', '/blocks', '/profiles', '/modqueue', '/log', '/fediacct', '/describe',
  '/atproto', '/atproto/connect', '/atproto/disconnect',
  '/rebuild', '/move', '/retire', '/inbox/prune', '/park', '/revive',
  '/fediacct/connect', '/fediacct/disconnect', '/fediacct/callback',
]);

// The page the fediverse account's OAuth redirect lands on (a top-level
// navigation, so it is HTML, not JSON). On success it steps back to the record
// page on its own; either way it offers the link.
function callbackHtml(ok, msg) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + (ok ? '<meta http-equiv="refresh" content="2;url=/admin/">' : '')
    + `<title>FediPod — ${ok ? 'connected' : 'not connected'}</title>`
    + '<link rel="stylesheet" href="/admin/tokens.css">'
    + '<style>body{font:20px/1.5 system-ui,sans-serif;margin:0;background:var(--surface);color:var(--fg);'
    + 'display:grid;min-height:100dvh;place-items:center}main{max-width:32rem;padding:2rem;text-align:center}'
    + 'h1{color:var(--heading)}a{color:var(--accent)}.err{color:var(--err)}</style></head><body><main>'
    + `<h1>${ok ? 'Account connected' : 'Could not connect'}</h1>`
    + `<p class="${ok ? '' : 'err'}">${esc(msg)}</p>`
    + '<p><a href="/admin/">Back to your account</a></p></main></body></html>';
}

export class AdminFacade {
  constructor({ agent, log = console.log }) { this.agent = agent; this.log = log; }

  // Resolve an old account (a URL, or @user@host) to its canonical actor id,
  // verifying by dereference the way intake does — a URL may claim any id, so
  // that id must answer for itself before it is stored as an alias.
  async resolveActor(input) {
    const a = this.agent;
    const s = String(input || '').trim().replace(/^@/, '');
    if (!s) return null;
    if (/^https?:\/\//.test(s)) {
      let doc = await a.intake.fetchAP(s).catch(() => null);
      if (doc?.id && doc.id !== s) {
        const own = await a.intake.fetchAP(doc.id).catch(() => null);
        doc = own?.id === doc.id ? own : null;
      }
      return doc?.id || null;
    }
    const at = s.indexOf('@');
    if (at < 1) return null;
    const host = s.slice(at + 1);
    const wf = `https://${host}/.well-known/webfinger?resource=${encodeURIComponent('acct:' + s)}`;
    try {
      const res = await a.deliverer.signedFetch(wf, { method: 'GET', headers: { accept: 'application/jrd+json' } });
      const jrd = await res.json();
      const self = (jrd?.links || []).find(l => l.rel === 'self' && /(activity|ld)\+json/.test(l.type || ''));
      if (!self?.href) return null;
      const doc = await a.intake.fetchAP(self.href).catch(() => null);
      return doc?.id || null;
    } catch { return null; }
  }

  /** Answer an admin data request. Returns true when it owns the path. */
  async handle(req, res, p, url, bodyText) {
    const a = this.agent;
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
      return true;
    };
    if (!ADMIN_PATHS.has(p)) return false;
    const method = req.method;
    const isGroup = () => a.store.getConfig()?.kind === 'group';

    // ---- reads ----
    if (method === 'GET') {
      switch (p) {
        case '/status': return json(200, a.status());
        case '/config': {
          const cfg = a.store.getConfig();
          if (!cfg) return json(409, { error: 'agent not configured' });
          const urls = a.urls || a.publisher?.urls || null;
          const wfHost = urls ? new URL(urls.base).host : null;
          const address = cfg.gateway?.frontActor
            ? `@${publicHandle(cfg)}@${new URL(cfg.gateway.frontActor).host}`
            : (wfHost ? `@${cfg.handle}@${wfHost}` : null);
          return json(200, {
            handle: cfg.handle, remotePod: cfg.remotePod, issuer: cfg.issuer,
            root: cfg.root || null, kind: cfg.kind || 'person',
            actor: urls?.actor || null, webId: a.webId || null,
            accountId: urls?.actor ? a.store.idFor(urls.actor) : null,
            address,
            name: cfg.name || null, summary: cfg.summary || null, icon: cfg.icon || null,
            image: cfg.image || null, fields: cfg.fields || [],
            aliases: cfg.aliases || [],
            autoAcceptFollows: !!cfg.autoAcceptFollows,
            hasUiPassword: !!cfg.uiPassword,
            quiescedAt: cfg.quiescedAt || null, movedTo: cfg.movedTo || null,
            mode: a.status().mode,
            // Live from the credential's actual backend on THIS browser (a
            // browser-stored connection is only present where its token is);
            // crossPost stays a default-on config value, no longer a toggle.
            atproto: (() => { const s = a.atproto?.status(); return s?.connected
              ? { handle: s.handle, service: s.service, did: s.did, connected: true, storage: s.storage, feedPaused: s.feedPaused, crossPost: cfg.atproto?.crossPost ?? true }
              : null; })(),
            fediAccounts: a.fediaccts?.status() || [],
          });
        }
        case '/gateway': {
          const g = a.store.getConfig()?.gateway || null;
          return json(200, {
            configured: !!(g && g.url), url: g?.url || null, webId: g?.webId || null,
            frontActor: g?.frontActor || null, mode: g?.mode || 'off', hasSecret: !!g?.hmacSecret,
            stats: a.store.read('gateway-stats.json', { verified: 0, unverified: 0, lastAt: null }),
          });
        }
        case '/deadletter': return json(200, { items: a.store.getDeadLetters() });
        case '/blocks': return json(200, a.store.getBlocklist());
        // One personal identity — no siblings on a machine to list. The bar's
        // dropdown shows this one plus "add an account".
        case '/profiles': {
          const s = a.status();
          const host = s.actor ? new URL(s.actor).host : null;
          return json(200, {
            identities: [{
              name: s.handle, current: true, handle: s.handle,
              address: (s.handle && host) ? `${s.handle}@${host}` : null,
              admin: '/admin/', app: '/app/', kind: s.kind, mode: s.mode,
            }],
          });
        }
        case '/modqueue': return json(200, []);           // person: no moderation queue
        case '/log': return json(200, { lines: [] });     // no local log file in the browser
        case '/fediacct': return json(200, { accounts: a.fediaccts?.status() || [] });
        case '/import':
          return json(200, a.importer ? a.importer.progress() : { running: false, total: 0, done: 0 });
        // The OAuth redirect returns here as a top-level navigation, so this one
        // answers with an HTML page, not JSON. It completes the connection, then
        // shows the result with a way back to the record page.
        case '/fediacct/callback': {
          const q = url.searchParams;
          const page = (ok, msg) => { res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' }); res.end(callbackHtml(ok, msg)); return true; };
          if (q.get('error')) return page(false, q.get('error_description') || q.get('error'));
          if (!q.get('code') || !q.get('state')) return page(false, 'that sign-in came back incomplete');
          try {
            const row = await a.fediaccts.complete({ state: q.get('state'), code: q.get('code') });
            // The roster is computed live from the backends by /config; a
            // browser-stored token must not put the account on the pod, so
            // nothing is written to pod config here.
            a.startAccts?.();
            return page(true, `${row.handle} is connected.`);
          } catch (e) { return page(false, e.message); }
        }
        default: return json(405, { error: 'GET not supported here' });
      }
    }

    if (method !== 'POST') return json(405, { error: 'POST only' });
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; }
    catch { return json(400, { error: 'expected JSON body' }); }

    // ---- writes ----
    switch (p) {
      case '/config': {
        const fixed = PERMANENT_CONFIG.filter(k => k in body);
        if (fixed.length) return json(400, { error: `${fixed.join(', ')} cannot be changed — that is the identity itself` });
        // Group-only knobs are not offered on a personal identity.
        for (const k of ['approveJoins', 'review', 'moderators']) {
          if (k in body) return json(404, { error: 'not a group' });
        }
        await a.requestTakeover?.();
        const cfg = { ...a.store.getConfig() };
        if ('name' in body) {
          if (!body.name) return json(400, { error: 'a display name is required' });
          cfg.name = String(body.name);
        }
        if ('summary' in body) cfg.summary = body.summary || undefined;
        if ('icon' in body) cfg.icon = body.icon || undefined;
        if ('image' in body) cfg.image = body.image || undefined;
        if ('fields' in body) {
          cfg.fields = (Array.isArray(body.fields) ? body.fields : [])
            .filter(f => f?.name?.trim())
            .map(f => ({ name: String(f.name).trim(), value: String(f.value ?? '').trim() }));
        }
        if ('autoAcceptFollows' in body) cfg.autoAcceptFollows = !!body.autoAcceptFollows;
        if ('password' in body) {
          if (body.password) cfg.uiPassword = hashPassword(body.password);
          else delete cfg.uiPassword;
        }
        const republish = WIRE_CONFIG.some(k => k in body);
        a.store.setConfig(cfg);
        if ('autoAcceptFollows' in body && a.publisher) a.publisher.config.autoAcceptFollows = cfg.autoAcceptFollows;
        if (republish && a.publisher) {
          Object.assign(a.publisher.config, {
            name: cfg.name, summary: cfg.summary, icon: cfg.icon,
            image: cfg.image, fields: cfg.fields, aliases: cfg.aliases,
          });
        }
        await a.store.flush();
        const pub = republish ? await a.publisher.publishProfile() : null;
        return json(200, {
          ok: true, published: republish,
          ...(pub?.unreachable?.length ? { unreachable: pub.unreachable } : {}),
        });
      }

      case '/describe': {
        const cfg = { ...a.store.getConfig() };
        if ('summary' in body) cfg.summary = body.summary || undefined;
        if ('icon' in body) cfg.icon = body.icon || undefined;
        a.store.setConfig(cfg);
        Object.assign(a.publisher.config, { summary: cfg.summary, icon: cfg.icon });
        await a.store.flush();
        await a.publisher.publishProfile();
        return json(200, { ok: true, summary: cfg.summary || null, icon: cfg.icon || null });
      }

      // Going quiet, and coming back. The record page's active/parked select.
      case '/park': {
        if (!await a.requestTakeover?.()) return json(503, { error: 'another device is active for this pod — park from there' });
        return json(200, { ok: true, ...await a.park() });
      }
      case '/revive': {
        if (!await a.requestTakeover?.()) return json(503, { error: 'another device is active for this pod — revive from there' });
        return json(200, { ok: true, ...await a.revive() });
      }

      case '/rotate-key': {
        await a.requestTakeover?.();
        // The pod's copy of the key is wrapped under the account password, so a
        // rotation has to be given one. 428 rather than 400: nothing is wrong
        // with the request, something is required before it can be made.
        try {
          const r = await a.rotateKey({ password: body.password });
          return json(200, { ok: true, changed: !!r?.changed });
        } catch (e) {
          if (e.code !== 'key-password-needed') throw e;
          return json(428, { error: e.message, needsPassword: true });
        }
      }

      // Recover posts this browser lost, from what the pod still holds.
      case '/rebuild': {
        if (!await a.requestTakeover?.()) return json(503, { error: 'another device is active for this pod — recover from there' });
        return json(200, await a.publisher.rebuildStatuses({ fromNotes: !!body.fromNotes }));
      }

      // Catch up on a backlog: drop old inbox posts (older than `before`) but
      // keep applying the follows/unfollows/accepts/deletes in that window. The
      // browser's own Intake does the work, exactly as the Node agent's does.
      case '/inbox/prune': {
        if (!body.before) return json(400, { error: 'before (a date) required' });
        if (!await a.requestTakeover?.()) return json(503, { error: 'another device is active for this pod — discard from there' });
        return json(200, await a.intake.prune({ before: body.before, ...(body.keepConcerning ? { keepConcerning: true } : {}) }));
      }

      // Hand the account away: a federated Move migrates followers to the
      // target, this handle is left redirecting. The typed-handle interlock is
      // the same as the Node agent's — a stray click cannot produce it.
      case '/move': {
        if (!body.target) return json(400, { error: 'target required' });
        if (!body.confirm || body.confirm !== a.store.getConfig()?.handle) {
          return json(400, { error: 'type the handle to confirm' });
        }
        await a.requestTakeover?.();
        let target = String(body.target).trim();
        if (!/^https?:\/\//.test(target)) {
          const id = await this.resolveActor(target);
          if (!id) return json(400, { error: `could not resolve ${body.target}` });
          target = id;
        }
        return json(200, { ok: true, ...await a.moveTo(target) });
      }

      // End the identity for good: a Delete to every follower, the actor
      // replaced by a Tombstone that stays fetchable. Typed-handle interlock.
      case '/retire': {
        if (!body.confirm || body.confirm !== a.store.getConfig()?.handle) {
          return json(400, { error: 'type the handle to confirm' });
        }
        await a.requestTakeover?.();
        return json(200, { ok: true, ...await a.publisher.retireActor() });
      }

      case '/alias': {
        const urls = a.publisher?.urls;
        if (!urls) return json(409, { error: 'agent not connected yet' });
        if (!body.add && !body.remove) return json(400, { error: 'add or remove required' });
        await a.requestTakeover?.();
        const cfg = { ...a.store.getConfig() };
        const aliases = [...(cfg.aliases || [])];
        if (body.add) {
          if (!webfingerHost(urls.base) && !cfg.gateway?.frontActor) {
            return json(400, { error: 'this pod is a path on a shared host, so other servers could never resolve it as a Move target' });
          }
          const id = await this.resolveActor(body.add);
          if (!id) return json(400, { error: `could not fetch the old account (${body.add}) — enter its URL or @user@host, and it must answer` });
          if (id === urls.actor) return json(400, { error: 'that is this account' });
          if (!aliases.includes(id)) aliases.push(id);
        } else {
          const target = String(body.remove).trim();
          if (!aliases.includes(target)) return json(404, { error: 'no such alias' });
          if (!body.confirm) {
            return json(409, { error: 'servers still retrying the Move check this alias — send confirm: true to remove it anyway' });
          }
          aliases.splice(aliases.indexOf(target), 1);
        }
        cfg.aliases = aliases;
        a.store.setConfig(cfg);
        a.publisher.config.aliases = aliases;
        await a.store.flush();
        const pub = await a.publisher.publishProfile();
        return json(200, { ok: true, aliases, ...(pub?.unreachable?.length ? { unreachable: pub.unreachable } : {}) });
      }

      case '/gateway': {
        const cfg = { ...a.store.getConfig() };
        const g = { ...(cfg.gateway || {}) };
        const inboxUrl = a.publisher?.urls?.inbox;
        if (body.action === 'check') {
          const front = String(body.front || '').replace(/\/+$/, '');
          try { new URL(front); } catch { return json(400, { error: 'front must be a gateway origin URL' }); }
          const chk = await fetch(`${front}/api/handle?handle=${encodeURIComponent(String(body.handle || '').toLowerCase())}`,
            { headers: { accept: 'application/json' } }).then(r => r.json()).catch(() => null);
          if (!chk) return json(502, { error: `${front} did not answer its handle check` });
          return json(200, { available: !!chk.available, reason: chk.reason || null });
        }
        await a.requestTakeover?.();
        const persist = async () => {
          cfg.gateway = g; a.store.setConfig(cfg);
          if (a.publisher) a.publisher.config.gateway = g;
          await a.store.flush();
        };
        if (body.action === 'configure') {
          if (!/^https:\/\/\S+$/.test(String(body.url || ''))) return json(400, { error: 'gateway url must be https' });
          if (!/^https?:\/\/\S+$/.test(String(body.webId || ''))) return json(400, { error: 'gateway webId must be a URL' });
          g.url = String(body.url); g.webId = String(body.webId);
          if (!g.hmacSecret) {
            const rnd = crypto.getRandomValues(new Uint8Array(32));
            g.hmacSecret = btoa(String.fromCharCode(...rnd));
          }
          g.mode = g.mode || 'off';
          if ('frontActor' in body) {
            const fa = String(body.frontActor || '');
            if (fa && !/^https:\/\/\S+\/ap\/actor$/.test(fa)) return json(400, { error: 'frontActor must be an https …/ap/actor URL' });
            g.frontActor = fa || undefined;
          }
          await persist();
          return json(200, { ok: true, mode: g.mode, url: g.url, webId: g.webId, hmacSecret: g.hmacSecret });
        }
        if (body.action === 'mode') {
          const target = body.mode;
          if (!['off', 'shadow', 'trust', 'locked'].includes(target)) return json(400, { error: 'mode must be off, shadow, trust or locked' });
          if (target !== 'off' && !g.url) return json(400, { error: 'point at a gateway first (action: configure)' });
          if (target === 'locked' && !g.webId) return json(400, { error: "locked needs the gateway's WebID — set it with action: configure" });
          const prev = g.mode || 'off';
          if (target === 'locked') await a.publisher?.lockInboxToGateway(g.webId);
          else if (prev === 'locked' && inboxUrl) await podInbox.setPosture(a.remote, a.urls, 'open');
          g.mode = target;
          await persist();
          if ((prev === 'off') !== (target === 'off')) await a.publisher?.publishProfile();
          else if (target !== 'off') await a.publisher?.publishGatewayPolicy().catch(() => {});
          return json(200, { ok: true, mode: g.mode });
        }
        // Attach the pod's mail through a gateway (fedipod.net and kin). The
        // agent proves the pod with its own DPoP session — no password — and the
        // front answers with the door URL and the receipt secret. Browser model
        // only: @you@yourpod (inbox door), never a fronted @you@front — the
        // latter renames every id and needs a process restart the browser has
        // no equivalent for.
        if (body.action === 'attach') {
          const front = String(body.front || '').replace(/\/+$/, '');
          let fu;
          try { fu = new URL(front); } catch { return json(400, { error: 'front must be the gateway origin, like https://fedipod.net' }); }
          if (fu.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$|\.localhost$/.test(fu.hostname)) return json(400, { error: 'front must be https' });
          if (body.fronted === true) return json(400, { error: 'a fronted @you@front identity is not the browser model — the browser uses the mail-door form @you@yourpod' });
          const named = !!String(body.handle || '').trim();
          let handle = String(body.handle || cfg.handle || '').toLowerCase().trim();
          if (!handle) return json(400, { error: 'a name at the gateway is required' });
          const avail = async (h) => fetch(`${front}/api/handle?handle=${encodeURIComponent(h)}`,
            { headers: { accept: 'application/json' } }).then(r => r.json()).catch(() => null);
          let chk = await avail(handle);
          if (!chk) return json(502, { error: `${front} did not answer its handle check` });
          if (!chk.available && !named) {
            for (let i = 2; i <= 9 && !chk.available; i++) {
              const cand = `${handle}${i}`; const c = await avail(cand);
              if (c?.available) { handle = cand; chk = c; }
            }
          }
          if (!chk.available) return json(409, { error: chk.reason || `the name ${handle} is taken at ${front}` });
          const attach = await a.remote.session.fetch(`${front}/api/attach`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ handle, podHome: a.urls.home, kind: cfg.kind || 'person', fronted: false }),
          }).catch(() => null);
          if (!attach) return json(502, { error: `${front} did not answer the attach` });
          const d = await attach.json().catch(() => ({}));
          if (attach.status !== 201) {
            return json(attach.status >= 400 && attach.status < 500 ? attach.status : 502, { error: d.error || `attach failed (HTTP ${attach.status})` });
          }
          g.url = String(d.doorInbox || `${front}/u/${handle}/ap/inbox/`);
          if (d.hmacSecret) g.hmacSecret = String(d.hmacSecret);
          if (!g.mode || g.mode === 'off') g.mode = 'shadow';
          await persist();
          await a.publisher?.publishProfile();
          await a.publisher?.publishGatewayPolicy?.().catch(() => {});
          return json(200, { ok: true, mode: g.mode, url: g.url });
        }
        // Detach: forget the gateway and re-advertise the pod's own inbox.
        if (body.action === 'forget') {
          if (g.frontActor) return json(400, { error: 'this identity publishes under a gateway front; detaching a front is not supported in the browser build' });
          const wasLocked = g.mode === 'locked';
          delete cfg.gateway; a.store.setConfig(cfg);
          if (a.publisher) a.publisher.config.gateway = undefined;
          await a.store.flush();
          if (wasLocked && inboxUrl) await podInbox.setPosture(a.remote, a.urls, 'open').catch(() => {});
          await a.publisher?.publishProfile();
          return json(200, { ok: true, mode: 'off', forgotten: true });
        }
        return json(400, { error: 'unknown gateway action' });
      }

      // Connect a Bluesky account. This is the one place an app password is
      // seen; it is stored owner-only on the pod (never returned), and the
      // mirror poll starts. Same shape as the Node agent's /atproto/connect.
      case '/atproto/connect': {
        if (!body.identifier || !body.appPassword) return json(400, { error: 'identifier and appPassword required' });
        await a.requestTakeover?.();
        let conn;
        try { conn = await a.atproto.connect({ service: body.service, identifier: body.identifier, appPassword: body.appPassword }); }
        catch (e) { return json(400, { error: e.message }); }
        const cfg = a.store.getConfig();
        a.store.setConfig({ ...cfg, atproto: { ...conn, crossPost: cfg.atproto?.crossPost ?? true } });
        await a.store.flush();
        a.startBsky?.();
        return json(200, { ok: true, ...a.atproto.status() });
      }
      case '/atproto/disconnect': {
        a.stopBsky?.();
        await a.atproto.disconnect();
        const { atproto, ...rest } = a.store.getConfig();
        a.store.setConfig(rest);
        await a.store.flush();
        return json(200, { ok: true });
      }
      // Bluesky settings: pause/resume the mirror, and move the credential
      // between this browser and the pod. Cross-post is default-on, not toggled.
      case '/atproto': {
        if (!a.atproto?.connected()) return json(400, { error: 'no bluesky account connected' });
        if ('feedPaused' in body) { a.atproto.setFeedPaused(!!body.feedPaused); a.restartBsky?.(); }
        if ('storage' in body) {
          if (!['pod', 'browser'].includes(body.storage)) return json(400, { error: 'storage must be pod or browser' });
          a.atproto.setStorage(body.storage);
        }
        return json(200, { ok: true, ...a.atproto.status() });
      }

      // Connect a fediverse account on another server: start its OAuth at that
      // server. The browser is then sent to `authorize`; the code comes back to
      // GET /fediacct/callback (above). The token never touches the pod.
      case '/fediacct/connect': {
        if (!body.host) return json(400, { error: 'the address of the server is required' });
        try {
          const { url: authorize } = await a.fediaccts.begin({ host: body.host, redirectUri: `${url.origin}/fediacct/callback` });
          return json(200, { ok: true, authorize });
        } catch (e) { return json(400, { error: e.message }); }
      }
      case '/fediacct/disconnect': {
        if (!body.id) return json(400, { error: 'id required' });
        await a.fediaccts.revoke(body.id);        // best-effort revoke at the server, then forget it here
        if (!a.fediaccts.remove(body.id)) return json(404, { error: 'no such account' });
        a.restartAccts?.();
        return json(200, { ok: true });
      }
      // Pause/resume the mirror, or move the credential between browser and pod.
      case '/fediacct': {
        if (!body.id) return json(400, { error: 'id required' });
        let row;
        if ('storage' in body) {
          if (!['pod', 'browser'].includes(body.storage)) return json(400, { error: 'storage must be pod or browser' });
          row = a.fediaccts.setStorage(body.id, body.storage);
        } else row = a.fediaccts.setEnabled(body.id, !!body.enabled);
        if (!row) return json(404, { error: 'no such account' });
        a.restartAccts?.();
        return json(200, { ok: true, account: row });
      }

      // CSV import — follows, blocks, mutes, lists and domains, staged onto the
      // pod and applied by a worker over the following minutes. The same
      // ImportWorker the Node agent runs (lib/import.mjs); it needs only the
      // store and social.mjs, both of which are in this bundle.
      case '/import': {
        if (!a.importer) return json(409, { error: 'agent not connected yet' });
        // Staging arms a worker that keeps writing for minutes, so a device
        // that could not take the lease must not run one beside the device
        // that holds it.
        if (!await a.requestTakeover?.()) {
          return json(503, { error: 'another device is active for this pod — import from there' });
        }
        if (body.clear === true) {
          a.importer.clear();
          return json(200, { ok: true, cleared: true });
        }
        if (!IMPORT_KINDS.includes(body.kind)) {
          return json(400, { error: `kind must be one of: ${IMPORT_KINDS.join(', ')}` });
        }
        if (typeof body.text !== 'string' || !body.text.trim()) {
          return json(400, { error: 'text required — the CSV file contents' });
        }
        const { values, invalid } = normalizeImport(body.kind, body.text);
        const r = a.importer.stage(body.kind, values);
        await a.store.flush();
        return json(200, {
          ok: true, kind: body.kind, ...r,
          invalid: invalid.length,
          ...(invalid.length ? { invalidSample: invalid.slice(0, 5) } : {}),
        });
      }

      default:
        return json(404, { error: 'not available on a personal browser identity' });
    }
  }
}
