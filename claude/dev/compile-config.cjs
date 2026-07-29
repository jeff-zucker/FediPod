// Compiles a Components.js server config to a single CommonJS factory, so the
// server starts with NO node_modules scanning.
//
//   node compile-config.cjs <mainModulePath> <configPath> > create-app.cjs
//
// Same trick as data-kitchen's pivot/compile-config.cjs, and for the same
// reason: componentsjs' runtime scan walks every ancestor node_modules and
// recurses into each package, so under ~/Dropbox/Web/solid it finds the
// file:-linked sol-components dev tree, whose comunica generation differs from
// the server's and poisons the registry. Compiling inside an isolated copy of
// the module tree keeps the scan away from it. The componentsjs CLI can't be
// used directly — it doesn't expose skipContextValidation/typeChecking, which
// CSS's own loader sets.
//
// Differs from dk's only in taking the config as an argument rather than
// resolving a fixed pivot-config/<entry>.json.

const { ComponentsManager } = require('componentsjs');
const { ConstructionStrategyCommonJsString } = require('componentsjs/lib/construction/strategy/ConstructionStrategyCommonJsString');
const path = require('path');

const APP_IRI = 'urn:solid-server:default:App';

async function main() {
  const mainModulePath = path.resolve(process.argv[2] || process.cwd());
  const configPath = path.resolve(process.argv[3] || '');
  const constructionStrategy = new ConstructionStrategyCommonJsString({ asFunction: true, req: require });
  const manager = await ComponentsManager.build({
    mainModulePath,
    constructionStrategy,
    configLoader: async (registry) => registry.register(configPath),
    skipContextValidation: true,
    typeChecking: false,
  });
  const serialized = await manager.instantiate(APP_IRI);
  process.stdout.write(`${constructionStrategy.serializeDocument(serialized)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
