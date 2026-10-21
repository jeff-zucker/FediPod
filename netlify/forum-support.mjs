// forum-support.mjs — whether this Gateway keeps forums. The Gateway's own code
// (lib/gateway/, netlify/functions/) never imports the forum; this file is the
// one place that names it, and the front hands what it exports to the door and
// the keeper.
//
//   with forums     import * as forum from 'fedipod-bb/gateway'; export default forum;
//   without forums  export default null;
//
// The forum is taken from its own folder, not a version FediPod pins:
// scripts/forum-package.mjs puts it in node_modules before the functions are
// bundled. It brings its own copy of fedipod for its own imports, and the
// function carries that copy beside it.

import * as forum from 'fedipod-bb/gateway';
export default forum;
