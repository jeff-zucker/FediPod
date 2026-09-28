// forum-support.mjs — whether this Gateway keeps forums. The Gateway's own code
// (lib/gateway/, netlify/functions/) never imports the forum; this file is the
// one place that names it, and the front hands what it exports to the door and
// the keeper.
//
//   with forums     import * as forum from '../packages/fedipod-bb/src/gateway.mjs'; export default forum;
//   without forums  export default null;
//
// The forum is named by its folder in this repository, not by its package name:
// Netlify's bundler packs a file of the repository into the function, but ships
// a package under node_modules beside it as loose files, with a second copy of
// fedipod for the forum's own imports. Outside this repository the line is
// `import * as forum from 'fedipod-bb/gateway'` after `npm install fedipod-bb`,
// and the function carries that second copy.

import * as forum from '../packages/fedipod-bb/src/gateway.mjs';
export default forum;
