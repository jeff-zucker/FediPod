// mastoapi.mjs — Mastodon client-API facade over ap-agent (M1: read + post).
// Modeled on snac2's approach: real implementations for the endpoints
// clients actually exercise, empty-collection stubs for the rest. Reached
// through the router (/api/*, /oauth/* → this port), so requests carry the
// gate; OAuth here is theater for a single already-trusted local user.
//
// Surface: oauth trio · instance v1/v2 · verify_credentials · timelines/home
// (M1) · notifications, relationships, lookup, follow/unfollow, thread
// context, /v2/search (M2) · favourite/reblog, media upload, markers,
// DELETE status (M3) · stub farm. Unknown /api/* GETs 404 and are LOGGED —
// that log is the running punch list.
//
// This file is the class and the dispatcher. The endpoints are in the modules
// beside it, one per area — oauth.mjs, instance.mjs, accounts.mjs,
// timelines.mjs, statuses.mjs, media.mjs — each exporting handle(api, ctx),
// which answers and returns true or returns false; handle() below walks them
// in order with the bearer gate between the public ones and the rest. The
// JSON shapes are render.mjs and the request readers body.mjs; every helper
// the areas reach through `api.` is a one-line delegation here.

import { Push } from '../webpush.mjs';
import * as oauth from './oauth.mjs';
import * as render from './render.mjs';
import * as instance from './instance.mjs';
import * as accounts from './accounts.mjs';
import * as timelines from './timelines.mjs';
import * as statuses from './statuses.mjs';
import * as media from './media.mjs';
export { hashPassword } from './oauth.mjs';
export { pollParams } from './body.mjs';
export { attachmentType, extensionFor } from './media.mjs';

export class MastoApi {
  constructor({ agent, log = console.log, allowed = null, scheme = null, embedded = false,
    streaming = true, webPush = true, scheduling = true }) {
    this.agent = agent;
    // A server-hosted identity has no CLI of its own, so the advice this gives
    // when it refuses has to name the route that identity really has.
    this.embedded = embedded;
    this.log = log;
    this.allowed = allowed;             // authorities a redirect_uri may name
    // The scheme this identity is reached on, when the socket cannot say —
    // a server behind a TLS proxy terminates cleartext and still is https.
    this.scheme = scheme;
    // Whether this deployment can serve the Mastodon streaming WebSocket. A
    // Node agent can; the in-browser service-worker facade cannot (it is
    // fetch-only), so it advertises NO streaming URL. Otherwise the client
    // opens wss://localhost/... (the worker has no request host to name), which
    // not only fails but, from a public origin, trips Chrome's private-network
    // permission prompt ("access other apps and services on this device").
    // With no streaming URL the client falls back to polling, which is served.
    this.streaming = streaming;
    // The same idea for two more capabilities the browser build does not have.
    // A client decides what to offer from what the instance document says, so
    // the honest thing is to say nothing rather than advertise and no-op.
    //
    // `webPush`: the browser build's web-push is a shim that mints a random
    // placeholder VAPID key and whose sendNotification does nothing. Advertised,
    // the client shows a notifications toggle that looks on and never fires.
    // Omit `vapid` and it hides the toggle instead.
    this.webPush = webPush;
    // `scheduling`: a scheduled post is only a stored row until something
    // publishes it when its time comes, and the only such tick is the Node
    // agent's (run-agent.mjs). Where nothing ticks, accepting one is silent
    // loss — the client says "scheduled" and the post never appears. Refusing
    // it is worse UX and better behaviour.
    this.scheduling = scheduling;
    this.authzAttempts = [];            // password-attempt timestamps
  }

  get store() { return this.agent.store; }
  get urls() { return this.agent.publisher?.urls; }
  get push() {
    this._push ||= new Push({
      store: this.store,
      subject: () => this.urls?.actor || 'https://localhost/',
      log: this.log,
    });
    return this._push;
  }
  get host() { return this.urls ? new URL(this.urls.base).host : 'unconfigured.invalid'; }

  // Where the live feed is, as the CLIENT must address it: this agent's own
  // origin, taken from the request, not the pod's host. An instance document
  // that leaves it empty is not merely unhelpful — clients read it without a
  // guard and fall over, and every one of them loses live updates.
  streamingUrl(req) {
    if (!this.streaming) return null;   // fetch-only facade: no WebSocket, no wss://localhost prompt
    const host = req?.headers?.host || `localhost:${this.port || ''}`;
    const secure = this.scheme
      ? this.scheme.startsWith('https')
      : req?.headers?.['x-forwarded-proto'] === 'https' || !!req?.socket?.encrypted;
    return `${secure ? 'wss' : 'ws'}://${host}/api/v1/streaming`;
  }

  static scopeFor(...a) { return oauth.scopeFor(...a); }
  static scopeAllows(...a) { return oauth.scopeAllows(...a); }
  static redirectMatches(...a) { return oauth.redirectMatches(...a); }
  static provesCode(...a) { return oauth.provesCode(...a); }

  // ---- request handling; returns true when handled ----
  async handle(req, res, pathname, url) {
    const send = (status, obj, headers = {}) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body);
      return true;
    };
    const ctx = { req, res, pathname, url, send };

    if (await oauth.handle(this, ctx)) return true;
    if (!pathname.startsWith('/api/')) return false;
    if (await instance.handle(this, ctx)) return true;

    // --- everything below needs a bearer token + a configured agent ---
    const bearer = this.tokenOf(req);
    if (!bearer) return send(401, { error: 'The access token is invalid' });
    // One gate for every client route below, rather than a check in each of
    // the fifty-odd branches — which is how the scope came to be recorded and
    // never consulted in the first place.
    const need = MastoApi.scopeFor(req.method, pathname);
    if (!MastoApi.scopeAllows(bearer.scope, need)) {
      this.log(`refused ${req.method} ${pathname}: token has "${bearer.scope}", needs "${need}"`);
      return send(403, { error: `This action is outside the authorized scopes (needs ${need})` });
    }
    if (!this.agent.configured()) return send(503, { error: 'agent not configured' });
    // A viewer-mode agent (another agent holds the drain lease) may not act —
    // but a user acting HERE outranks the idle active agent elsewhere, so a
    // write attempt claims the lease and proceeds. Only a failed claim 503s.
    if (this.agent.viewer && req.method !== 'GET' && req.method !== 'HEAD') {
      const took = await this.agent.requestTakeover?.();
      if (!took) return send(503, { error: 'another agent is active for this pod — takeover failed, try again' });
    }

    for (const area of [accounts, timelines, statuses, media]) {
      if (await area.handle(this, ctx)) return true;
    }

    this.log(`mastoapi: unhandled ${req.method} ${pathname} — punch list`);
    return send(404, { error: `Unimplemented: ${req.method} ${pathname}` });
  }

  // oauth.mjs
  tokenRecords(...a) { return oauth.tokenRecords(this, ...a); }
  tokens(...a) { return oauth.tokens(this, ...a); }
  mintToken(...a) { return oauth.mintToken(this, ...a); }
  apps(...a) { return oauth.apps(this, ...a); }
  authorizationServerMetadata(...a) { return oauth.authorizationServerMetadata(this, ...a); }
  findApp(...a) { return oauth.findApp(this, ...a); }
  resolveClientDocument(...a) { return oauth.resolveClientDocument(this, ...a); }
  registerApp(...a) { return oauth.registerApp(this, ...a); }
  mintCode(...a) { return oauth.mintCode(this, ...a); }
  consumeCode(...a) { return oauth.consumeCode(this, ...a); }
  tokenOf(...a) { return oauth.tokenOf(this, ...a); }
  authed(...a) { return oauth.authed(this, ...a); }
  redirectAllowed(...a) { return oauth.redirectAllowed(this, ...a); }
  rateLimited(...a) { return oauth.rateLimited(this, ...a); }

  // render.mjs
  selfAccount(...a) { return render.selfAccount(this, ...a); }
  account(...a) { return render.account(this, ...a); }
  page(...a) { return render.page(this, ...a); }
  bskyReply(...a) { return render.bskyReply(this, ...a); }
  acctAction(...a) { return render.acctAction(this, ...a); }
  acctReply(...a) { return render.acctReply(this, ...a); }
  status(...a) { return render.status(this, ...a); }
  filtersFor(...a) { return render.filtersFor(this, ...a); }
  lookup(...a) { return render.lookup(this, ...a); }
  statusOrBoost(...a) { return render.statusOrBoost(this, ...a); }
  pushNotify(...a) { return render.pushNotify(this, ...a); }
  scheduledJson(...a) { return render.scheduledJson(this, ...a); }
  pollJson(...a) { return render.pollJson(this, ...a); }
  mediaJson(...a) { return render.mediaJson(this, ...a); }
  relationship(...a) { return render.relationship(this, ...a); }
  notificationType(...a) { return render.notificationType(this, ...a); }
  notification(...a) { return render.notification(this, ...a); }
  accountSearch(...a) { return render.accountSearch(this, ...a); }

  // instance.mjs
  instanceTitle(...a) { return instance.instanceTitle(this, ...a); }
  tagObject(...a) { return instance.tagObject(this, ...a); }
  instanceBlurb(...a) { return instance.instanceBlurb(this, ...a); }
}
