// keep.mjs — letting a Gateway keep this forum: it acts for the forum when
// nothing else does, from the pod's own rules, which name its keeper beside
// the owner from then on. Taking the name out again is the same in reverse.

import { restateRules } from 'fedipod/pod/containers.mjs';
import * as podInbox from 'fedipod/pod/inbox.mjs';
import * as publish from './publish.mjs';
import { provisionForum, provisionCategory } from './provision.mjs';

// Let a Gateway keep this forum: it acts for the forum when nothing else
// does, from the pod's own rules, which name it beside the owner from here
// on. `on: false` takes the name out again.
export async function keepForum(forum, { front, on = true }) {
  const origin = String(front).replace(/\/+$/u, '');
  const handles = [forum.config.handle, ...forum.categories.map(c => c.slug)];
  let keeper = null;
  for (const handle of handles) {
    const res = await forum.remote.session.fetch(`${origin}/api/keeper`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, on, ...(handle === forum.config.handle ? {} : { forum: forum.config.handle }) }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${origin} would not ${on ? 'keep' : 'let go of'} @${handle}: ${d.error || res.status}`);
    keeper = d.keeper || keeper;
  }
  forum.keepers = on && keeper ? [keeper] : [];
  forum.remote.keepers = [...forum.keepers];
  forum.remote.aclOwner = forum.readCredential()?.webId || forum.remote.aclOwner || null;
  await forum.restateRules();
  return { keeper: on ? keeper : null, handles, on };
}

// Every rule on the forum's tree, stated again with the names this host
// carries: the containers, the inboxes, the reader lists, and the documents
// that state a rule of their own.
export async function restateForumRules(forum) {
    await provisionForum(forum.remote, forum.site, { moderatorWebIds: forum.config.moderatorWebIds || [] });
  await restateRules(forum.remote, forum.site).catch(e => forum.log(`restating the forum's rules: ${e.message}`));
  await podInbox.setPosture(forum.remote, forum.site, 'open');
  for (const cat of forum.categories) {
    await provisionCategory(forum.remote, cat.urls, { memberWebIds: forum.membersOf(cat) });
    await restateRules(forum.remote, cat.urls).catch(e => forum.log(`restating ${cat.slug}'s rules: ${e.message}`));
    await publish.publishMembers(cat, forum.readersOf(cat), { force: true }).catch(e => forum.log(`the reader list for ${cat.slug}: ${e.message}`));
    await podInbox.setPosture(forum.remote, cat.urls, 'closed');
    for (const base of [cat.urls.topicContainer, cat.urls.cache]) {
      const children = await forum.remote.listContainer?.(base).catch(() => []) || [];
      for (const child of children) if (!child.url.endsWith('/')) await forum.remote.restateAcl?.(child.url).catch(() => null);
    }
  }
}
