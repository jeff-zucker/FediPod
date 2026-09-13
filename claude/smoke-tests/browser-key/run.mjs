// Bundle entry.mjs, serve it, run it in headless Chrome, print the results.
//   node claude/smoke-tests/browser-key/run.mjs
import { buildApp } from '../../../scripts/build-app.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = fs.mkdtempSync('/tmp/fedipod-browser-key-');
await buildApp({ entry: path.join(here, 'entry.mjs'), out: path.join(outDir, 'test.js') });
fs.writeFileSync(path.join(outDir, 'index.html'), '<!doctype html><title>key</title><body><script type="module" src="test.js"></script>');
let finish; const done = new Promise((r) => { finish = r; });
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/done') {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { res.writeHead(204); res.end(); finish(b); });
    return;
  }
  const f = path.join(outDir, req.url === '/' ? 'index.html' : req.url);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
// The page reports by POSTing to /done; Chrome is killed once that arrives or
// after the timeout. Spawned asynchronously because this process serves it.
const chrome = execFile('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${outDir}/profile`, url], { encoding: 'utf8' }, () => {});
const timer = setTimeout(() => finish('FAIL  timed out waiting for the page'), 60000);
let body;
try { body = await done; } finally {
  clearTimeout(timer); chrome.kill('SIGKILL'); server.close(); fs.rmSync(outDir, { recursive: true, force: true });
}
console.log(body || '(no output — the page did not finish)');
process.exit(/FAIL/.test(body) || !/PASS/.test(body) ? 1 : 0);
