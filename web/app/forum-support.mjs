// forum-support.mjs — whether this site's sign-up page offers a forum. The
// page's own code never imports the forum; this file is the one place that
// names the forum's setup module, and the page hides the choice when it is
// null. The counterpart of netlify/forum-support.mjs, which decides whether
// the Gateway behind this page keeps forums: the two go together.
//
//   with forums     import * as setup from '../../packages/fedipod-bb/src/setup.mjs'; export default setup;
//   without forums  export default null;

import * as setup from '../../packages/fedipod-bb/src/setup.mjs';
export default setup;
