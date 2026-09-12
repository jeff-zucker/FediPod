// connections.mjs — the accounts held elsewhere: a Bluesky account and
// accounts on other fediverse servers, connected, adjusted, disconnected;
// and the page the other server's sign-in comes back to.



// The page the other server's redirect lands on. Self-contained on purpose:
// the browser arrives here from somewhere else, and nothing may load from
// that somewhere.
function callbackPage(ok, msg) {
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const head = ok ? 'Account connected' : 'Not connected';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${head}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.7 system-ui, -apple-system, sans-serif; margin: 0;
         padding: 2.5rem 2rem; background: #ffffff; color: #1a1a1a; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.375rem; font-weight: 500; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #16161a; color: #ececf0; }
  }
</style></head>
<body><main>
<h1>${head}</h1>
<p>${esc(msg)}</p>
<p>You can close this tab and go back to FediPod.</p>
</main></body></html>
`;
}

export async function get(p, ctx, req, res, url) {   // eslint-disable-line no-unused-vars
  const { agent, log, allowed, embedded, port, publicOrigin, versionOnDisk, isGroup } = ctx;   // eslint-disable-line no-unused-vars
  const json = (res, status, obj) => { ctx.json(res, status, obj); return true; };

  if (req.method === 'GET' && p === '/fediacct') {
    return json(res, 200, { accounts: agent.fediaccts?.status() || [] });
  }
  // Where the other server sends the browser back. A GET, so it gets none
  // of the POST branch's local-only protection for free and asks for its
  // own — a code arriving from anywhere else is not the owner's.
  if (req.method === 'GET' && p === '/fediacct/callback') {
    if (!embedded && !allowed.isLocalRequest(req)) {
      return json(res, 403, { error: 'connecting an account is available on this machine only' });
    }
    const q = new URL(req.url, 'https://x.invalid').searchParams;
    const done = (ok, msg) => {
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(callbackPage(ok, msg));
      return true;
    };
    if (q.get('error')) return done(false, q.get('error_description') || q.get('error'));
    if (!q.get('code') || !q.get('state')) return done(false, 'that sign-in came back incomplete');
    try {
      const row = await agent.fediaccts.complete({ state: q.get('state'), code: q.get('code') });
      const cfg = agent.store.getConfig();
      agent.store.setConfig({ ...cfg, fediAccounts: agent.fediaccts.roster() });
      await agent.store.flush();
      agent.restartAccts?.();
      return done(true, `${row.handle} is connected.`);
    } catch (e) { return done(false, e.message); }
  }

  return false;
}

export async function post(p, body, ctx, req, res) {   // eslint-disable-line no-unused-vars
  const { agent, log, allowed, embedded, port, publicOrigin, versionOnDisk, isGroup } = ctx;   // eslint-disable-line no-unused-vars
  const json = (res, status, obj) => { ctx.json(res, status, obj); return true; };
  switch (p) {
    case '/atproto/connect': {
      // The one endpoint that ever sees the app password; loopback-only.
      if (!body.identifier || !body.appPassword) {
        return json(res, 400, { error: 'identifier and appPassword required' });
      }
      const conn = await agent.atproto.connect({
        service: body.service, identifier: body.identifier, appPassword: body.appPassword,
      });
      const cfg = agent.store.getConfig();
      agent.store.setConfig({
        ...cfg,
        atproto: { ...conn, crossPost: cfg.atproto?.crossPost ?? true },
      });
      await agent.store.flush();
      agent.startBsky?.();
      return json(res, 200, { ok: true, ...agent.atproto.status() });
    }
    case '/atproto/disconnect': {
      agent.stopBsky?.();
      await agent.atproto.disconnect();
      const { atproto, ...rest } = agent.store.getConfig();
      agent.store.setConfig(rest);
      await agent.store.flush();
      return json(res, 200, { ok: true });
    }
    case '/atproto': {
      // Non-secret settings only — today that is the cross-post toggle.
      const cfg = agent.store.getConfig();
      if (!cfg.atproto) return json(res, 400, { error: 'no bluesky account connected' });
      agent.store.setConfig({
        ...cfg, atproto: { ...cfg.atproto, crossPost: !!body.crossPost },
      });
      await agent.store.flush();
      return json(res, 200, { ok: true, atproto: { ...cfg.atproto, crossPost: !!body.crossPost } });
    }
    case '/fediacct/connect': {
      // Starts the sign-in at the other server. Loopback-only, and the
      // redirect returns to the origin the owner is actually using, not a
      // guess — a client reaches this agent by several names.
      if (!body.host) return json(res, 400, { error: 'the address of the server is required' });
      try {
        const { url } = await agent.fediaccts.begin({
          host: body.host, redirectUri: `https://${req.headers.host}/fediacct/callback`,
        });
        return json(res, 200, { ok: true, authorize: url });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    case '/fediacct/disconnect': {
      if (!body.id) return json(res, 400, { error: 'id required' });
      if (!await agent.fediaccts.remove(body.id)) return json(res, 404, { error: 'no such account' });
      const cfg = agent.store.getConfig();
      agent.store.setConfig({ ...cfg, fediAccounts: agent.fediaccts.roster() });
      await agent.store.flush();
      agent.restartAccts?.();
      return json(res, 200, { ok: true });
    }
    case '/fediacct': {
      // Non-secret settings only — today that is whether it is polled.
      if (!body.id) return json(res, 400, { error: 'id required' });
      const row = agent.fediaccts.setEnabled(body.id, !!body.enabled);
      if (!row) return json(res, 404, { error: 'no such account' });
      const cfg = agent.store.getConfig();
      agent.store.setConfig({ ...cfg, fediAccounts: agent.fediaccts.roster() });
      await agent.store.flush();
      agent.restartAccts?.();
      return json(res, 200, { ok: true, account: row });
    }
    default: return false;
  }
}
