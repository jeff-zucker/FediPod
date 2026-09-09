// stage-site.mjs — assemble the deployable static site for the in-browser agent.
//
// Output (web/app/site/, gitignored): the sign-up and sign-in pages at the
// root, the boot glue and the agent service worker (sw.js must be at the root
// so it controls the whole origin), and Phanpy under /app/ with its own
// service-worker registration removed so only the agent worker runs.
//
//   node scripts/build-app.mjs --entry web/app/sw-src.mjs  --out web/app/dist/sw.js
//   node scripts/build-app.mjs --entry web/app/boot.mjs    --out web/app/dist/boot.js
//   node scripts/stage-site.mjs
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'web/app/site');
fs.rmSync(site, { recursive: true, force: true }); fs.mkdirSync(path.join(site, 'app'), { recursive: true });
const cp = (from, to) => fs.copyFileSync(path.join(root, from), path.join(site, to));
cp('web/app/index.html', 'index.html');
cp('web/app/dist/boot.js', 'boot.js');
cp('web/app/dist/sw.js', 'sw.js');
const copyDir = (from, to) => { fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.name === 'sw.js' || e.name === 'sw.js.map') { /* drop Phanpy's own worker */ }
    else if (e.name === 'index.html') fs.writeFileSync(d, fs.readFileSync(s, 'utf8').replace(/<script id="vite-plugin-pwa:inline-sw">[\s\S]*?<\/script>/i, ''));
    else fs.copyFileSync(s, d);
  } };
copyDir(path.join(root, 'phanpy/dist'), path.join(site, 'app'));
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
      .replace('>manage account</a>', '>manage account</a>\n  <a id="bar-signout" href="/?signout" title="   Sign out of FediPod and clear this browser">sign out</a>')
      .replace('</head>', '<style>#actor-pick{display:none!important}</style>\n</head>');
    if (/[/\\]client$/.test(from)) {
      // The client shell frames the client at /app/ (locally the client is the
      // origin root, so the source says "../../").
      text = text.replace('src="../../"', 'src="/app/"');
    } else if (/[/\\]admin$/.test(from)) {
      // Hide controls the browser build does not carry: the manual drain (it
      // drains automatically over notifications) and the local logfile viewer
      // (there is no local log in a browser). And rename "Recover posts" to the
      // plainer "Refresh Feed" for this audience.
      text = text
        .replace('<style>#actor-pick', '<style>#do-drain,#do-log,#actor-pick')
        .replace('>Recover posts<', '>Refresh Feed<')
        .replace('Put back posts this machine lost, from what the pod still holds',
          'Refresh your feed from what your pod still holds');
    }
    fs.writeFileSync(d, text);
  } };
copyAdmin(path.join(root, 'web/admin'), path.join(site, 'admin'));
// Netlify routing. The project sends every path to the gateway function by
// default, which would shadow these static files, so file-based rules (which
// win over the project's UI redirect) serve the app directly and forward only
// the gateway's own paths to the function. First match wins.
fs.writeFileSync(path.join(site, '_redirects'), [
  '# gateway + front API → the function',
  '/api/handle             /.netlify/functions/front  200',
  '/api/attach             /.netlify/functions/front  200',
  '/api/relay              /.netlify/functions/front  200',
  '/api/roster             /.netlify/functions/front  200',
  '/api/revoke             /.netlify/functions/front  200',
  '/api/agent              /.netlify/functions/front  200',
  '/u/*                    /.netlify/functions/front  200',
  '/.well-known/*          /.netlify/functions/front  200',
  '/install                /.netlify/functions/front  200',
  '/run                    /.netlify/functions/front  200',
  '/roster                 /.netlify/functions/front  200',
  '/solid-oidc-client.js   /.netlify/functions/front  200',
  '# the in-browser app, served static (these win over the project catch-all)',
  '/            /index.html    200',
  '/sw.js       /sw.js         200',
  '/boot.js     /boot.js       200',

  '/app         /app/          301',
  '/app/*       /app/:splat    200',
  '/admin       /admin/        301',
  '/admin/*     /admin/:splat  200',
  '', ].join('\n'));
let n = 0; (function count(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? count(path.join(d, e.name)) : n++; })(site);
console.log(`staged web/app/site — ${n} files`);
