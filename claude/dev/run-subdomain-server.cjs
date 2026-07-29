// Starts the local dev pod from the pre-compiled subdomain config
// (dist/create-app-subdomain.cjs — build it with build-subdomain-config.sh).
// No componentsjs scanning at startup; this is plain instantiation.
//
//   node run-subdomain-server.cjs [rootFilePath] [port]
//
// Loopback only: CSS 7 calls listen(port) with no host and offers no config
// variable for one, so it would bind every interface — every numeric listen is
// pinned here instead. The default is ::1 rather than 127.0.0.1 because
// *.localhost resolves to ::1 first on this machine and Node's resolver is
// verbatim, so an IPv4-only bind would leave http://<pod>.localhost:4000/
// unreachable to the agent. AP_DEV_POD_HOST overrides.

const net = require('node:net');
const path = require('path');

const HOST = process.env.AP_DEV_POD_HOST || '::1';
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, ...rest) {
  if (typeof port === 'number') return origListen.call(this, port, HOST, ...rest);
  return origListen.call(this, port, ...rest);
};

const createApp = require('./dist/create-app-subdomain.cjs');

const rootFilePath = path.resolve(process.argv[2] || path.join(__dirname, 'pod-root'));
const port = Number(process.argv[3] || 4000);
const baseUrl = process.env.AP_DEV_POD_BASEURL || `http://localhost:${port}/`;

const VAR = 'urn:solid-server:default:variable:';

async function main() {
  const app = createApp({
    [`${VAR}baseUrl`]: baseUrl,
    [`${VAR}port`]: port,
    [`${VAR}rootFilePath`]: rootFilePath,
    [`${VAR}loggingLevel`]: 'info',
    [`${VAR}showStackTrace`]: true,
    [`${VAR}confirmMigration`]: false,
    [`${VAR}seedConfig`]: undefined,
    [`${VAR}socket`]: undefined,
    [`${VAR}workers`]: 1,
  });
  await app.start();
  console.log(`dev pod on ${baseUrl} (bound ${HOST}:${port}) serving ${rootFilePath}`);
  console.log('subdomain identifiers + webacl: pods land at http://<name>.localhost:' + port + '/');
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
