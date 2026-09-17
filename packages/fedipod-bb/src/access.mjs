// access.mjs — who may read a private category, and what follows from that:
// the reader list its members' own pods copy into their access rules, reading
// a member's post back as the forum rather than as a federating server, and
// letting go of a follower the category could never let read.
//
// Each takes the forum as its first argument, the way settings.mjs and
// moderation.mjs do.

// Who may read a private category: the WebIDs the forum was given for it,
// and its moderators'. Null means the category is OPEN, which is the usual
// case and the only thing that makes its pages public. A private category
// with nobody named yet returns an empty list, not null: the pod keeps
// everyone out rather than letting everyone in.
export function membersOf(forum, cat) {
  const closed = (forum.config.membersOnly || []).includes(cat.slug);
  if (!closed) return null;
  const named = forum.config.memberWebIds || {};
  return [...new Set([...(named[cat.slug] || []), ...(forum.config.moderatorWebIds || [])])];
}

// Who a private category's posts are written for: its members, its
// moderators, and the forum itself. The forum is on the list because it
// fetches every post back from its author's pod to check who wrote it
// (FEP-fe34), and a rule that left it out would refuse the forum the post it
// was just handed. Null for an open category.
export function readersOf(forum, cat) {
  const members = membersOf(forum, cat);
  if (!members) return null;
  const mine = forum.remote?.webId;
  return [...new Set([...members, ...(mine ? [mine] : [])])];
}

// One document read as the forum itself rather than as a federating server.
// Straight to the session: a foreign pod's answer is not this pod's business
// and must not be gated behind its cooldown or run through its url map.
export async function podFetchAP(forum, url) {
  const send = forum.remote?.session?.fetch
    ? (u, i) => forum.remote.session.fetch(u, i)
    : (u, i) => forum.remote.fetch(u, i);
  try {
    const r = await send(url, { headers: { accept: 'application/activity+json, application/ld+json, application/json;q=0.9' } });
    if (!r?.ok) return null;
    const doc = await r.json().catch(() => null);
    return doc && typeof doc === 'object' ? doc : null;
  } catch (e) {
    forum.log(`reading ${url} as the forum: ${e.message}`);
    return null;
  }
}

// A private category carries only to people its members' pods can let read,
// and that means a WebID. Anyone else following it — every follower it
// gathered while it was open, on Mastodon or anywhere else without one — is
// let go and told, rather than being sent posts they are refused.
export async function dropUnreadableFollowers(forum, cat) {
  if (!(forum.config.membersOnly || []).includes(cat.slug)) return 0;
  const contacts = cat.store.getContacts();
  const dropped = [];
  for (const f of [...contacts.followers]) {
    const webid = await forum.webIdOf(f.actor).catch(() => null);
    if (webid) continue;
    dropped.push(f);
    contacts.followers = contacts.followers.filter(x => x.actor !== f.actor);
  }
  if (!dropped.length) return 0;
  cat.store.setContacts(contacts);
  await cat.publisher.publishCollections({ followers: true }).catch(() => {});
  const wire = await import('../../../lib/core/wire.mjs');
  for (const f of dropped) {
    const inbox = f.sharedInbox || f.inbox;
    if (!inbox) continue;
    await cat.deliverer.deliver(inbox, wire.rejectActivity({
      urls: cat.urls, serial: Date.now(),
      followActivity: { id: f.followId || undefined, type: 'Follow', actor: f.actor, object: cat.urls.actor },
    })).catch(e => forum.log(`telling ${f.actor} the category is private: ${e.message}`));
  }
  forum.log(`${cat.slug} is private: ${dropped.length} follower(s) with no WebID let go`);
  return dropped.length;
}
