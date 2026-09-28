// What the agent says, when the agent lives in a service worker.
//
// The worker's console is not the page's, so a harness that only watches the
// page sees nothing at all from the thing it is testing. This attaches to the
// worker target and collects its console output, which is where every `log()`
// call in the agent ends up.
//
// Returns { lines, close }. `lines` fills as the worker talks.
export async function watchWorkerLog(WebSocket, cdpPort, { match = /sw\.js$/ } = {}) {
  const lines = [];
  let target = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json().catch(() => []);
    target = list.find((t) => t.type === 'service_worker' && match.test(t.url || ''));
    if (target?.webSocketDebuggerUrl) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!target?.webSocketDebuggerUrl) return { lines, close() {} };

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => no(new Error('worker cdp'))); });
  let id = 0;
  const say = (method) => ws.send(JSON.stringify({ id: ++id, method }));
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.consoleAPICalled') {
      lines.push(d.params.args.map((a) => a.value ?? a.description ?? JSON.stringify(a.preview || '')).join(' '));
    }
    if (d.method === 'Runtime.exceptionThrown') {
      lines.push('THREW ' + (d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text || ''));
    }
  });
  say('Runtime.enable');
  return { lines, close() { try { ws.close(); } catch { /* already gone */ } } };
}
