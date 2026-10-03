// stage-site.mjs — assemble the deployable static site for the in-browser agent.
//
// Output (web/app/site/, gitignored): the sign-up and sign-in pages at the
// root, the boot glue and the agent service worker (sw.js must be at the root
// so it controls the whole origin), and Phanpy under /app/ with its own
// service-worker registration removed so only the agent worker runs.
//
//   npm run build:app     # both bundles, into web/app/dist/
//   npm run stage         # this script
//
// The bundles are tracked, so rebuild and commit them in the SAME commit as
// whatever source change caused them — a dist that does not match its own
// source is the hardest kind of thing to see in the browser build.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'web/app/site');
fs.rmSync(site, { recursive: true, force: true }); fs.mkdirSync(path.join(site, 'app'), { recursive: true });
const cp = (from, to) => fs.copyFileSync(path.join(root, from), path.join(site, to));
cp('web/app/index.html', 'index.html');
cp('web/app/dist/boot.js', 'boot.js');
cp('web/app/dist/sw.js', 'sw.js');
cp('web/app/update.js', 'update.js');
// The remote-follow door another server sends its reader to. Static, because
// the account doing the following is the agent in that reader's browser.
cp('web/app/authorize_interaction.html', 'authorize_interaction.html');
cp('web/app/authorize_interaction.js', 'authorize_interaction.js');
// Every page carries the version it was staged with and the script that
// compares it with the site's and reloads once when a newer build is up.
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
// Hosts that are the forum page and nothing else: domain aliases of this site.
const BB_HOSTS = (process.env.BB_HOSTS || 'bb.fedipod.net').split(',').map(s => s.trim()).filter(Boolean);
// What this staging produced: a stamp that changes with every deploy, so a
// page already open can tell that it is out of date.
const BUILD = createHash('sha256').update(String(Date.now()) + VERSION).digest('hex').slice(0, 12);
const withUpdate = (html) => html.replace('</head>',
  `<meta name="fedipod-version" content="${VERSION}">\n<meta name="fedipod-build" content="${BUILD}">\n<script src="/update.js" defer></script>\n</head>`);
const injectUpdate = (file) => fs.writeFileSync(file, withUpdate(fs.readFileSync(file, 'utf8')));
const copyDir = (from, to) => { fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.name === 'sw.js' || e.name === 'sw.js.map') { /* drop Phanpy's own worker */ }
    else if (e.name === 'index.html') fs.writeFileSync(d, withUpdate(fs.readFileSync(s, 'utf8').replace(/<script id="vite-plugin-pwa:inline-sw">[\s\S]*?<\/script>/i, '')));
    else fs.copyFileSync(s, d);
  } };
copyDir(path.join(root, 'phanpy/dist'), path.join(site, 'app'));
// A second client at /sengi, so the owner has a choice. Sengi is a plain
// client-side Angular SPA whose whole OAuth login runs in the browser, so the
// worker answers its API calls exactly as it answers Phanpy's. Vendored
// without its Angular service worker and without any emoji pictures — this
// origin has one worker, and the emoji come from the JoyPixels CDN (Sengi
// patch 10), which keeps 3,828 files out of every deploy.
const copyPlain = (from, to) => { fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyPlain(s, d); else fs.copyFileSync(s, d);
  } };
copyPlain(path.join(root, 'sengi/dist'), path.join(site, 'sengi'));

// The clients this site carries, and which one it opens by default: the FIRST
// is the default. It is what /admin/client/ frames, and so where signing in
// lands. `login` names a client the shell can log in for the owner — that is
// client.js, and it speaks Phanpy's routes and reads Phanpy's stored accounts;
// Sengi is added once through its own "+" and remembers itself after that.
//
// Each client gets its OWN shell page, whose markup declares the app it frames.
// Nothing here is ever loaded into a frame by script.
const CLIENTS = [
  { id: 'sengi', name: 'Sengi', path: '/sengi/', login: false },
  { id: 'phanpy', name: 'Phanpy', path: '/app/', login: true },
];
// Sibling shells rather than nested ones, so `../bar.css`, `../bar.js` and
// `../` for "manage account" mean the same thing on every one of them.
const shellPath = (c) => (c === CLIENTS[0] ? '/admin/client/' : `/admin/client-${c.id}/`);
// The shell as copyAdmin leaves it — brand link, sign out, hidden actor picker,
// version stamp — before any one client's marks are made on it. Every shell is
// cut from this, so none of them inherits another's.
let shellSource = null;

// One client's shell, out of the source shell web/admin/client/index.html.
// Two things differ between them: what the frame declares it loads, and whether
// client.js comes along — it logs Phanpy in for the owner and knows only
// Phanpy's routes and stored accounts.
const shell = (text, c) => text
  .replace('src="../../"', `src="${c.path}"`)
  .replace('<script src="client.js"></script>',
    c.login ? '<script src="/admin/client/client.js"></script>' : '')
  .replace('<span id="account-pick">', `${clientBar()}\n  <span id="account-pick">`)
  .replace('</head>', '<script src="/admin/client-pick.js"></script>\n</head>')
  .replace('</body>', `${clientNews()}</body>`);

// The bar control: every client as a link, the current one marked. The same
// markup on the record page and on every shell, so the answer to "which client
// am I using" is in the same place wherever the owner is. The links carry their
// destinations; client-pick.js only marks the current one and records a change.
// One element around the label and the links, so a narrow bar wraps the control
// as a unit instead of leaving a client stranded on a line of its own.
const clientBar = () => '\n  <span id="client-pick"><span id="client-now">client:</span>'
  + CLIENTS.map((c) => `\n  <a class="client-switch" href="${shellPath(c)}"`
    + ` title="   Open this account in ${c.name} and keep it as the client this browser uses">${c.name}</a>`).join('')
  + '</span>';

// Said once, to somebody who last saw one client and now has two. It is a
// change to a page they already know, so it is worth a sentence — and only one,
// shown once per browser, dismissed for good.
const clientNews = () => `
<dialog id="client-news" aria-labelledby="client-news-title">
  <section>
    <h2 id="client-news-title">There are two clients now</h2>
    <p>You can read your account in <b>${CLIENTS.map((c) => c.name).join('</b> or in <b>')}</b>.
      The links at the top right of this page switch between them, and this browser
      stays with whichever you choose. You can switch between clients at any time.</p>
    <p class="row"><button id="client-news-ok" class="primary">Got it</button></p>
  </section>
</dialog>
`;

// The owner's record/manage surface: the SAME web/admin pages the Node agent
// serves, reused as static files (the agent answers their data endpoints from
// the worker — see admin-facade.mjs). Two browser adaptations: the client shell
// frames the client at /app/ (locally the client is the origin root, so the
// source says "../../"), and the manual "Drain the inbox" control is hidden —
// the browser drains automatically over notifications.
const copyAdmin = (from, to) => { fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) { copyAdmin(s, d); continue; }
    if (e.name !== 'index.html') { fs.copyFileSync(s, d); continue; }
    // Every bar in the browser build: no "Local actors" dropdown (there is one
    // identity per browser), and the FediPod brand is a link to the sign-in /
    // add-a-pod page — /?add shows it without bouncing a signed-in user back
    // into the client, so setup is always one click from the bar.
    let text = fs.readFileSync(s, 'utf8')
      .replace('<h1 class="name">FediPod</h1>', '<h1 class="name"><a href="/?add">FediPod</a></h1>')
      // A sign-out beside "manage account", on every bar. It clears the FediPod
      // session, the client's stored account, browser-stored connected keys, and
      // the worker — the /?signout page (boot.js) does the teardown.
      .replace(/(<a id="bar-manage"[^>]*>manage<\/a>)/u, '$1\n  <a id="bar-signout" href="/?signout" title="   Sign out of FediPod and clear this browser">sign out</a>')
      .replace('</head>', '<style>#actor-pick{display:none!important}</style>\n</head>');
    text = withUpdate(text);
    if (/[/\\]client$/.test(from)) {
      // This copy is the DEFAULT client's shell; the others are written out
      // below, each cut from the same unmarked source.
      shellSource = text;
      text = shell(text, CLIENTS[0]);
    } else if (/[/\\]admin$/.test(from)) {
      // The record page carries the same client control as the shells: it is
      // the page the owner is on when they want to change which client opens.
      text = text.replace('<span id="account-pick">', `${clientBar()}\n  <span id="account-pick">`)
        .replace('</head>', '<script src="/admin/client-pick.js"></script>\n</head>')
  .replace('</body>', `${clientNews()}</body>`);
      // Hide controls the browser build does not carry: the manual drain (it
      // drains automatically over notifications), the local logfile viewer
      // (there is no local log in a browser), and the "create a handle at the
      // gateway" choice — a fronted @you@front identity is not the browser
      // model, and admin-facade.mjs refuses one outright. Leaving the radio
      // visible meant the page checked the name's availability as you typed,
      // told you it was free, and then refused the attach. With it hidden the
      // pod-based choice stays selected, so that check never runs either.
      // And rename "Recover posts" to the plainer "Refresh Feed" for this
      // audience.
      text = text
        .replace('<style>#actor-pick', '<style>#gw-shape-front,#do-drain,#do-log,#actor-pick')
        .replace('>Recover posts<', '>Refresh Feed<')
        // The move-to-another-gateway hint: only the browser build can move
        // in (signup.mjs moveIn), so only here does gateway.js get to show it.
        .replace('id="gw-move-hint" hidden>', 'id="gw-move-hint-browser" hidden>')
        .replace('Put back posts this machine lost, from what the pod still holds',
          'Refresh your feed from what your pod still holds');
    }
    fs.writeFileSync(d, text);
  } };
copyAdmin(path.join(root, 'web/admin'), path.join(site, 'admin'));
// The favicons. One for the gateway's own pages, one for this account's pages,
// one for the forum — so three FediPod tabs are three different tabs.
copyPlain(path.join(root, 'web/icons'), path.join(site, 'icons'));
// A shell per client that is not the default, beside the default's own. Each is
// cut from the same unmarked staged text, so no client's page carries a trace of
// another's — the Phanpy shell lost its own client.js when these were made from
// the Sengi one, which had already dropped it.
for (const c of CLIENTS.slice(1)) {
  const dir = path.join(site, `admin/client-${c.id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), shell(shellSource, c));
}
// Netlify routing. The project sends every path to the gateway function by
// default, which would shadow these static files, so file-based rules (which
// win over the project's UI redirect) serve the app directly and forward only
// the gateway's own paths to the function. First match wins.
fs.writeFileSync(path.join(site, '_redirects'), [
  '# gateway + front API → the function',
  '/api/handle             /.netlify/functions/front  200',
  '/api/server             /.netlify/functions/front  200',
  '/api/attach             /.netlify/functions/front  200',
  '/api/relay              /.netlify/functions/front  200',
  '/api/roster             /.netlify/functions/front  200',
  '/api/revoke             /.netlify/functions/front  200',
  '/api/agent              /.netlify/functions/front  200',
  '/api/notices            /.netlify/functions/front  200',
  '/notices                /.netlify/functions/front  200',
  '/notices.js             /.netlify/functions/front  200',
  '/u/*                    /.netlify/functions/front  200',
  '/.well-known/*          /.netlify/functions/front  200',
  '/@*                     /.netlify/functions/front  200',
  '/install                /.netlify/functions/front  200',
  '/run                    /.netlify/functions/front  200',
  '/roster                 /.netlify/functions/front  200',
  '/solid-oidc-client.js   /.netlify/functions/front  200',
  '# The forum at its own host: bb.<domain> is a domain alias of this site, and',
  '# every path there is the forum page (forced: / would otherwise be the app).',
  '# The page names its forum by the first path segment and reads through <domain>.',
  ...BB_HOSTS.flatMap(h => [
    `http://${h}/*          https://${h}/:splat  301!`,
    // One forum on this site, so its root IS that forum.
    `https://${h}/           /forum/         301!`,
    `https://${h}/bb/*      /bb/:splat      200!`,
    `https://${h}/icons/*   /icons/:splat   200!`,
    `https://${h}/update.js /update.js      200!`,
    `https://${h}/build.json /build.json     200!`,
    `https://${h}/api/*     /.netlify/functions/front  200!`,
    `https://${h}/*         /bb/index.html  200!`,
  ]),
  '# the in-browser app, served static (these win over the project catch-all)',
  '/            /index.html    200',
  '/sw.js       /sw.js         200',
  '/boot.js     /boot.js       200',
  // The path other servers hand their readers on a remote follow. It has no
  // extension, so it needs a rule of its own; the page's script beside it is a
  // file Netlify serves without one.
  '/authorize_interaction  /authorize_interaction.html  200',

  '/app         /app/          301',
  '/app/*       /app/:splat    200',
  '/bb          /bb/           301',
  '/bb/*        /bb/:splat     200',
  '/admin       /admin/        301',
  '/admin/*     /admin/:splat  200',
  // Sengi routes client-side from its own root, and its OAuth redirect comes
  // back to `/sengi/` with the code in the query — so every path under it is
  // that one page, and the bare path is the page too.
  '/sengi       /sengi/        301',
  '/sengi/*     /sengi/:splat  200',
  '', ].join('\n'));
// Response headers. Same-origin IS the trust boundary for this build — the
// worker answers the admin routes on this origin, and one page here renders
// fediverse HTML from strangers — so `script-src 'self'` is what stands
// between a remote post and the identity. Only `/app/*` and `/admin/*` are
// given a CSP header here: the root page carries its own `<meta>` CSP, tuned
// to its issuer, and a header would intersect with it and break the login.
//
// Netlify reads ONE `_headers`, at the publish root. (Phanpy ships its own
// under `app/`, which is why that copy has never done anything.)
//
// `Referrer-Policy: same-origin` and not `no-referrer`: the worker's own gate
// reads `request.referrer` to tell the bundled client's sign-in navigation
// from a cross-site one (sw-src.mjs), and stripping it everywhere would refuse
// the legitimate one. Same-origin sends it to us and to nobody else.
//
// `style-src` keeps `'unsafe-inline'`: the admin pages get a `<style>` block
// injected above, and `innerHTML` with a `style=` attribute is common in both.
// Inline STYLE cannot exfiltrate the way inline SCRIPT can, and tightening it
// would cost the boundary nothing. `/app/*` needs `https:` for images and
// media because the whole point of the client is rendering other servers'
// avatars and attachments.
// FediPod-BB: the forum website, static, reading a forum through this site's
// own /u/<handle>/ or a pod named outright. Its script is a module file of
// its own, so it is served under the same `script-src 'self'` as the app.
fs.mkdirSync(path.join(site, 'bb'), { recursive: true });
for (const f of ['index.html', 'bb.js', 'read.mjs', 'masto.mjs', 'pod.mjs', 'markdown.mjs', 'seen.mjs', 'mine.mjs', 'private.mjs', 'oidc-session.mjs']) cp(`packages/fedipod-bb/site/${f}`, `bb/${f}`);
cp('web/admin/tokens.css', 'bb/tokens.css');   // the site's shared palette, size and family
cp('lib/session/oidc-session.mjs', 'bb/solid-oidc-session.mjs');   // signing in to a pod: the library the forum's binding names
// The account library's demo page, with the library beside it, under /demo/.
fs.mkdirSync(path.join(site, 'demo'), { recursive: true });
for (const f of ['fedi-account.mjs', 'fedi-login.mjs', 'oidc-session.mjs']) cp(`lib/session/${f}`, `demo/${f}`);
cp('web/admin/tokens.css', 'demo/tokens.css');
// The page a Mastodon app sends its person to (lib/gateway/masto-gateway.mjs),
// with the pod sign-in library and the palette beside it, as the demo has.
fs.mkdirSync(path.join(site, 'app-signin'), { recursive: true });
for (const f of ['index.html', 'app-signin.mjs']) cp(`web/app-signin/${f}`, `app-signin/${f}`);
for (const f of ['fedi-login.mjs', 'oidc-session.mjs']) cp(`lib/session/${f}`, `app-signin/${f}`);
cp('web/admin/tokens.css', 'app-signin/tokens.css');
fs.writeFileSync(path.join(site, 'demo/index.html'),
  fs.readFileSync(path.join(root, 'lib/session/demo.html'), 'utf8').replace('../../web/admin/tokens.css', './tokens.css'));
// Each file the forum page loads is named with a hash of its content. A
// browser holding the last build cannot serve half of it back: the page is
// revalidated (no-cache below) and every url under it changes with its bytes.
{
  const bb = (n) => path.join(site, 'bb', n);
  const stamp = (n) => createHash('sha256').update(fs.readFileSync(bb(n))).digest('hex').slice(0, 10);
  const sub = (n, pairs) => { let t = fs.readFileSync(bb(n), 'utf8');
    for (const [a, b] of pairs) t = t.split(a).join(b); fs.writeFileSync(bb(n), t); };
  sub('oidc-session.mjs', [["'fediverse-session/oidc-session.mjs'", `'./solid-oidc-session.mjs?v=${stamp('solid-oidc-session.mjs')}'`]]);
  sub('pod.mjs', [["'./oidc-session.mjs'", `'./oidc-session.mjs?v=${stamp('oidc-session.mjs')}'`],
    ["'./markdown.mjs'", `'./markdown.mjs?v=${stamp('markdown.mjs')}'`],
    ["'./private.mjs'", `'./private.mjs?v=${stamp('private.mjs')}'`],
    ["'./mine.mjs'", `'./mine.mjs?v=${stamp('mine.mjs')}'`]]);
  sub('bb.js', [["'./read.mjs'", `'./read.mjs?v=${stamp('read.mjs')}'`], ["'./masto.mjs'", `'./masto.mjs?v=${stamp('masto.mjs')}'`],
    ["'./pod.mjs'", `'./pod.mjs?v=${stamp('pod.mjs')}'`], ["'./seen.mjs'", `'./seen.mjs?v=${stamp('seen.mjs')}'`],
    ["'./markdown.mjs'", `'./markdown.mjs?v=${stamp('markdown.mjs')}'`],
    ["'./mine.mjs'", `'./mine.mjs?v=${stamp('mine.mjs')}'`]]);
  sub('index.html', [['"/bb/bb.js"', `"/bb/bb.js?v=${stamp('bb.js')}"`], ['"/bb/tokens.css"', `"/bb/tokens.css?v=${stamp('tokens.css')}"`]]);
}
injectUpdate(path.join(site, 'bb/index.html'));
injectUpdate(path.join(site, 'index.html'));
injectUpdate(path.join(site, 'authorize_interaction.html'));
fs.writeFileSync(path.join(site, '_headers'), [
  // The worker and the update script are fetched fresh, so a new build is
  // seen the moment it is up; the pages themselves revalidate by default.
  '/sw.js',
  '  Cache-Control: no-cache',
  '/update.js',
  '  Cache-Control: no-cache',
  '',
  // The remote-follow page: it is arrived at from another server, and it drives
  // the owner's own /follow route, so it gets the same refusal of anything
  // inline that the pages behind it do.
  '/authorize_interaction',
  "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: same-origin',
  '',
  '/app/*',
  "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self' https:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: same-origin',
  '',
  '/admin/*',
  "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: same-origin',
  '',
  // The forum site reads a pod and talks to a reader's Mastodon server, so
  // connect-src reaches https:; it renders posts the forum's host sanitised,
  // and inline script is still refused.
  '/bb/*',
  // Revalidate every time: the page and its modules are small, and a stale
  // page with fresh modules (or the reverse) is the failure this prevents.
  '  Cache-Control: no-cache',
  "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: same-origin',
  '',
  // The page a Mastodon app sends its person to signs them in at their pod,
  // so it reaches the pod's identity provider.
  '/app-signin/*',
  '  Cache-Control: no-cache',
  "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: same-origin',
  '',
  // The account demo reads pods and Mastodon servers and shows their avatars.
  '/demo/*',
  '  Cache-Control: no-cache',
  "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: same-origin',
  '', ].join('\n'));
fs.writeFileSync(path.join(site, 'build.json'), JSON.stringify({ build: BUILD, version: VERSION, at: new Date().toISOString() }) + '\n');
let n = 0; (function count(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? count(path.join(d, e.name)) : n++; })(site);
console.log(`staged web/app/site — ${n} files`);
