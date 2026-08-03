// ports.mjs — finding a port nothing else is on.
//
// This lived twice, in bin/activitypod.mjs and lib/admin.mjs, and the two
// copies had already drifted: one returned null when it ran out of ports and
// the other threw. Both spawn agents, so which one you got decided whether a
// full range produced an error message or a silent undefined.

import net from 'node:net';

// Bind to find out. Something holding a port without answering HTTP reads as
// free to a probe that only asks for a response, and the new agent then dies on
// EADDRINUSE with nobody watching.
export function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

// null when the whole span is taken. Callers that want an error say so in their
// own words — the CLI has a person reading it, the admin API has a status code.
export async function freePortFrom(first, span = 50) {
  for (let p = first; p < first + span; p++) if (await portFree(p)) return p;
  return null;
}
