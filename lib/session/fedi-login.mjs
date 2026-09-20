// fedi-login.mjs — sign a person in at their own Solid pod from their
// Fediverse address, and bring them back to where they were.
//
//   import { fediLogin } from './fedi-login.mjs';
//   const login = fediLogin({ dbName: 'my-app-oidc', clientName: 'My app' });
//
//   await login.login('@mei@fedipod.net');   // leaves for the pod's login page
//   await login.resume();                     // on every page load: finishes a
//                                             // login in progress and returns them
//   const s = await login.getSession();       // null, or { webId, issuer, fetch, signOut }
//
// How an address becomes a login page. WebFinger at the address's host names
// the actor and its aliases. An origin among those that answers
// /.well-known/openid-configuration is the login provider, or says which is
// (a pod host redirects there). Failing that, the WebID — the URL typed, or
// the ones the actor names as its own — is read as JSON-LD and its
// solid:oidcIssuer is the provider. A Mastodon address has neither, and the
// person is told so in words.
//
// No imports but the session engine beside it, no Node built-ins, nothing
// named after the application that uses it.
import { solidOidcSession } from './oidc-session.mjs';

const OIDC_ISSUER = 'http://www.w3.org/ns/solid/terms#oidcIssuer';

/** `@mei@host`, `mei@host`, or a WebID or actor URL. Null when it is neither. */
export function parseAddress(input) {
  const t = String(input || '').trim();
  if (/^https?:\/\//u.test(t)) { try { return { url: new URL(t).href, host: new URL(t).host }; } catch { return null; } }
  const m = /^@?([^@\s/]+)@([^@\s/]+)$/u.exec(t);
  if (!m) return null;
  const name = m[1]; const host = m[2].toLowerCase();
  return { name, host, at: `@${name}@${host}` };
}

export function fediLogin({ dbName, clientName, redirectUri = null, fetch: f = globalThis.fetch?.bind(globalThis) } = {}) {
  const oidc = solidOidcSession({ dbName, clientName });
  const get = (url, accept) => f(url, { headers: { accept }, redirect: 'follow' });
  const json = (url, accept) => get(url, accept).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const here = () => (globalThis.location ? location.origin + location.pathname : null);

  const discovery = (base) => json(`${String(base).replace(/\/+$/, '')}/.well-known/openid-configuration`, 'application/json');
  const isProvider = (cfg) => !!(cfg?.issuer && cfg.authorization_endpoint);
  const origin = (u) => { try { return new URL(u).origin; } catch { return null; } };

  // The issuer a WebID document names, read as the expanded JSON-LD a pod answers.
  const issuerOfWebId = async (webId) => {
    const doc = await json(webId, 'application/ld+json');
    const nodes = Array.isArray(doc) ? doc : (doc?.['@graph'] || (doc ? [doc] : []));
    const me = nodes.find((n) => n?.['@id'] === webId && n[OIDC_ISSUER]) || nodes.find((n) => n?.[OIDC_ISSUER]);
    const v = [].concat(me?.[OIDC_ISSUER] || [])[0];
    return typeof v === 'string' ? v : (v?.['@id'] || null);
  };

  /** Where an address signs in: { address, actor, origin, issuer, webId? }.
   *  Throws, in plain words, when the host does not know the address or
   *  nothing about it names a login provider. */
  async function resolve(address) {
    const a = parseAddress(address);
    if (!a) throw new Error('an address looks like @you@your.server');
    let actor = null;
    const urls = [];
    if (a.url) urls.push(a.url);
    else {
      const r = await get(`https://${a.host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${a.name}@${a.host}`)}`,
        'application/jrd+json, application/json').catch(() => null);
      if (!r?.ok) throw new Error(`${a.host} does not know ${a.at}`);
      const jrd = await r.json().catch(() => null);
      const self = (jrd?.links || []).find((l) => l.rel === 'self' && /activity\+json|ld\+json/u.test(l.type || ''));
      actor = self?.href || null;
      // The aliases first: at a Gateway they name the actor on the pod itself,
      // and the pod is where the login is.
      for (const u of [...(jrd?.aliases || []), ...(actor ? [actor] : [])]) if (typeof u === 'string') urls.push(u);
      if (!urls.length) throw new Error(`${a.host} did not say where ${a.at} lives`);
    }
    const found = (extra) => ({ address: a.at || a.url, actor, ...extra });

    // 1. An origin that is the login provider, or says which is.
    for (const o of [...new Set(urls.map(origin).filter(Boolean))]) {
      const cfg = await discovery(o);
      if (isProvider(cfg)) return found({ origin: o, issuer: cfg.issuer });
    }
    // 2. The WebID: the URL typed, or the ones the actor names as its own.
    const webIds = a.url ? [a.url] : [];
    if (actor) {
      const doc = await json(actor, 'application/activity+json');
      for (const u of [].concat(doc?.alsoKnownAs || [])) if (typeof u === 'string') webIds.push(u);
    }
    for (const webId of webIds) {
      const issuer = await issuerOfWebId(webId);
      if (issuer && isProvider(await discovery(issuer))) return found({ origin: origin(webId), issuer, webId });
    }
    throw new Error(`${a.host} is not a Solid pod, so there is no pod login to send you to`);
  }

  /** Everything `login` does short of leaving the page: returns the found pod
   *  and the `authorizationUrl` to send the person to. */
  async function startLogin(address, { returnTo = globalThis.location?.href || null, redirectUri: ru = redirectUri || here() } = {}) {
    const found = await resolve(address);
    const { authorizationUrl } = await oidc.beginLogin({ issuer: found.issuer, redirectUri: ru, returnTo });
    return { ...found, authorizationUrl, returnTo };
  }

  /** Send the person to their pod's login page. They come back to `redirectUri`
   *  (this page, unless set) and `resume` there returns them to `returnTo`
   *  (where they were, unless set). */
  async function login(address, opts) {
    const s = await startLogin(address, opts);
    location.href = s.authorizationUrl;
    return s;
  }

  /** Call on every page load. Finishes a login the person is coming back from
   *  and returns them to where they were; null when no login is in progress. */
  async function resume({ currentUrl = globalThis.location?.href, go = (u) => location.replace(u) } = {}) {
    const session = await oidc.completeLogin({ currentUrl });
    if (!session) return null;
    if (session.returnTo && session.returnTo !== currentUrl) go(session.returnTo);
    return session;
  }

  return { resolve, startLogin, login, resume, getSession: oidc.getSession, signOut: oidc.signOut };
}
