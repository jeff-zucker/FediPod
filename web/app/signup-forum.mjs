// signup-forum.mjs — a forum made from the sign-up page. The person made a pod
// for it at a provider and is signed in as that pod; this writes the forum on
// the pod, takes its addresses here, and names this site its keeper. The
// keeper's first run, started by the last switch, mints the forum's keys and
// publishes its actors. Nothing of the person's own account is touched, and
// nothing runs on their machine afterwards.

import forumSetup from './forum-support.mjs';
import { BrowserRemotePod } from './pod-remote.mjs';
import { HttpStorage } from '../../lib/core/storage.mjs';
import { podBaseOfWebId } from '../../lib/pod/urls.mjs';
import { resourceExists } from '../../lib/pod/root.mjs';
import { findAccount } from '../../lib/core/place.mjs';
import { handleProblem, assertFrontNameFree, readConfigAt } from './signup.mjs';
import { categoriesFrom, moderatorFrom } from './forum-form.mjs';

/** Whether this site makes forums at all (web/app/forum-support.mjs). */
export const forumsOffered = () => !!forumSetup;

export async function signUpForum({ handle, name, categories, moderator = '' }, { session, onStep = () => {}, frontOrigin = null } = {}) {
  if (!forumSetup) throw new Error('This site does not host forums.');
  if (!frontOrigin) throw new Error('A forum lives at a gateway, and this page has none.');
  const bad = handleProblem(handle);
  if (bad) throw new Error(`Forum handle: ${bad}`);
  if (!String(name || '').trim()) throw new Error('A forum name is required.');
  const cats = categoriesFrom(categories);
  const mod = moderatorFrom(moderator, frontOrigin);
  if (!session?.webId || typeof session.fetch !== 'function') throw new Error("sign in at the forum's pod first");

  const webId = session.webId;
  const pod = podBaseOfWebId(webId);
  const remote = new BrowserRemotePod(session, { webId, role: 'signup', log: () => {} });

  // A forum needs a pod of its own: not one that hosts an account, not one
  // that holds a forum already; and its names must be free here.
  onStep('pod', 'running');
  if (await findAccount(remote, pod, readConfigAt(remote, pod))) {
    throw new Error('This pod already hosts a FediPod account. A forum needs a pod of its own.');
  }
  if (await resourceExists(session.fetch, pod + forumSetup.ROOT)) {
    throw new Error('This pod already holds a forum.');
  }
  for (const h of [handle, ...cats.map((c) => c.slug)]) await assertFrontNameFree(frontOrigin, h);
  onStep('pod', 'ok');

  const made = await forumSetup.setUpForumAtGateway({
    remote, storageFor: (base, fetch) => new HttpStorage(base, fetch), fetch: (u, i) => session.fetch(u, i),
    front: frontOrigin, ownerWebId: webId, remotePod: pod, handle, name: String(name).trim(), categories: cats,
    moderators: mod ? [mod] : [], moderatorWebIds: [webId],
  }, { onStep });
  return { handle: made.handle, front: made.front, address: `@${made.handle}@${new URL(made.front).host}` };
}
