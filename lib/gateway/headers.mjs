// headers.mjs — the hardening every front response carries, in one place.
// Split out of front-core.mjs, which is at its size gate; nothing here knows
// about routes.

// Every response this file makes, hardened in one place rather than in each of
// the dozen shapes below.
//
// `nosniff` matters most: the front serves user-supplied JSON straight from
// somebody's pod (the proxied actor and object documents), and without it a
// browser is free to decide for itself that a document is HTML and run what is
// inside it. The rest is the same posture the app already has — nothing may be
// framed, no base tag may be rewritten, no plugin content.
//
// A content-security-policy goes on the HTML only: it would mean nothing on a
// JSON document, and `frame-ancestors` has to be a header rather than a meta
// tag anyway.
//
// `script-src 'self'` is the one that matters, and it is only possible because
// none of these pages carries inline script any more — each has its own file and
// its own route above. A policy cannot tell an inline block the author wrote
// from one an attacker injected, so as long as any inline script has to run,
// every inline script may.
//
// `connect-src` allows https: because the pages sign in against the user's own
// pod, which is a different origin by definition and not one we can name here.
export function withSecurityHeaders(headers = {}, body = null) {
  const ct = String(headers['content-type'] || '');
  const isHtml = ct.startsWith('text/html');
  return {
    ...headers,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'SAMEORIGIN',
    ...(isHtml && body ? {
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self'",             // no inline script: see above
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' https: data:",
        "connect-src 'self' https:",     // sign-in goes to the user's own pod
        "object-src 'none'",             // no plugin content, ever
        "base-uri 'none'",               // no rewriting where relative URLs resolve
        "frame-ancestors 'self'",        // nobody else may frame these pages
        "form-action 'self'",            // a form here submits here
      ].join('; '),
    } : {}),
  };
}

