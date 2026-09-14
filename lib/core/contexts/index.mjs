// contexts/index.mjs — the JSON-LD contexts fediverse documents name,
// held here so reading one never reaches the network.
//
// Copied from @fedify/vocab-runtime, which keeps this set against real traffic.
// Copied rather than imported because that package pulls node:process, which
// the browser agent's bundle cannot resolve — and because what we serve for a
// stranger's document should be a file we can see, not a transitive dependency.
// To refresh: node scripts/refresh-contexts.mjs
//
// Two of these have never been fetchable in the first place. joinmastodon.org
// has never served a document for the toot: namespace that some implementations
// name; purl.archive.org, which hosts the SWICG miscellany, goes down.

import ctx0 from './activitystreams.json' with { type: 'json' };
import ctx1 from './security-v1.json' with { type: 'json' };
import ctx2 from './security-data-integrity-v1.json' with { type: 'json' };
import ctx3 from './security-data-integrity-v2.json' with { type: 'json' };
import ctx4 from './did-v1.json' with { type: 'json' };
import ctx5 from './security-multikey-v1.json' with { type: 'json' };
import ctx6 from './identity-v1.json' with { type: 'json' };
import ctx7 from './webfinger.json' with { type: 'json' };
import ctx8 from './schemaorg.json' with { type: 'json' };
import ctx9 from './gotosocial.json' with { type: 'json' };
import ctx10 from './fep-5711.json' with { type: 'json' };
import ctx11 from './join-lemmy.json' with { type: 'json' };
import ctx12 from './joinmastodon.json' with { type: 'json' };
import ctx13 from './miscellany.json' with { type: 'json' };
// Not from fedify: the W3C Web Annotation context, which a client such as
// dokieli names on the annotations it posts to the outbox.
import ctx14 from './anno.json' with { type: 'json' };

/** URL → the context document itself. Nothing outside this map is ever resolved. */
export const CONTEXTS = {
  'https://www.w3.org/ns/activitystreams': ctx0,
  'https://w3id.org/security/v1': ctx1,
  'https://w3id.org/security/data-integrity/v1': ctx2,
  'https://w3id.org/security/data-integrity/v2': ctx3,
  'https://www.w3.org/ns/did/v1': ctx4,
  'https://w3id.org/security/multikey/v1': ctx5,
  'https://w3id.org/identity/v1': ctx6,
  'https://purl.archive.org/socialweb/webfinger': ctx7,
  'http://schema.org/': ctx8,
  'https://gotosocial.org/ns': ctx9,
  'https://w3id.org/fep/5711': ctx10,
  'https://join-lemmy.org/context.json': ctx11,
  'http://joinmastodon.org/ns': ctx12,
  'https://purl.archive.org/miscellany': ctx13,
  'http://www.w3.org/ns/anno.jsonld': ctx14,
};
