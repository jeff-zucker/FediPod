// settings.mjs — changing what the forum IS, asked for the way everything
// else is asked for: a moderator publishes the request at their own pod and
// the forum fetches it back from there before acting (FEP-fe34).
//
// Every request is ordinary ActivityStreams. A category is created by a
// Create of a Group naming the forum; a name is changed by an Update; who
// moderates and who may read are Add and Remove naming the collection they
// belong to. Nothing here invents a word.

const idOf = (v) => (typeof v === 'string' ? v : v?.id);
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;

// A page reading the forum through a Gateway names what it asks about by the
// address it read there; read from the pod it names the pod's own. The queue
// container has no published address at all, since nothing about it is
// published. So both sides are put in the same space before they are compared,
// and an ask means what it says whichever address it arrived under.
const onPod = (forum, u) => (typeof u === 'string' && forum?.toPod ? forum.toPod(u) : u);
const same = (forum, a, b) => !!a && !!b && (a === b || onPod(forum, a) === onPod(forum, b));

// Which of these a delivered activity is, if any. The forum's own actor or
// one of its collections has to be named, or it is somebody else's business.
export function isSettingsAsk(forum, activity) {
  const t = activity?.type;
  const target = idOf(activity?.target);
  const object = activity?.object;
  const site = forum.site;
  if (t === 'Create' && object && typeof object === 'object' && object.type === 'Group') {
    return same(forum, idOf(activity.target), site.actor);
  }
  if (t === 'Update' && object && typeof object === 'object') {
    const id = idOf(object);
    return same(forum, id, site.actor) || forum.categories.some(c => same(forum, c.urls.actor, id));
  }
  if (t === 'Add' || t === 'Remove') {
    if (!target) return false;
    if (same(forum, target, site.administrators) || same(forum, target, site.mod)) return true;
    return forum.categories.some(c => same(forum, target, c.urls.moderators) || same(forum, target, c.urls.members));
  }
  return false;
}

// Apply one. Returns what changed, for the record the moderators read.
export async function applySettings(forum, activity) {
  const t = activity?.type;
  const object = activity?.object;
  const target = idOf(activity?.target);
  const site = forum.site;
  const cfg = () => forum.store.getConfig();
  // The record on the pod IS the forum: everything published is written from
  // it, and a start reads it back. A change that never reached it was still
  // published, and the next start quietly republished the old lists over the
  // top — a moderator added, announced, and gone again with nothing said. So
  // the change is written first, and a write that fails puts memory back and
  // says so instead of going on to publish.
  const save = async (next) => {
    const before = cfg();
    forum.store.setConfig({ ...before, ...next });
    forum.config = forum.store.getConfig();
    try {
      await forum.store.flush();
    } catch (e) {
      forum.store.setConfig(before);
      forum.config = forum.store.getConfig();
      throw new Error(`the forum's own record could not be written (${e.message}) — nothing was changed`);
    }
  };

  if (t === 'Create' && object?.type === 'Group') {
    const slug = String(object.preferredUsername || '').toLowerCase();
    if (!SLUG.test(slug)) throw new Error(`not a category slug: ${slug}`);
    const cats = cfg().categories || [];
    if (cats.some(c => c.slug === slug)) return { unchanged: slug };
    // Private: joining is approved by a moderator (AS2's own
    // manuallyApprovesFollowers) and only those admitted may read it. It
    // starts readable by the moderators, since a category nobody can read is
    // a category nobody can moderate.
    const priv = object.manuallyApprovesFollowers === true;
    const next = {
      categories: [...cats, { slug, name: String(object.name || slug).slice(0, 200), private: priv }],
      republish: true,
    };
    if (priv) {
      next.membersOnly = [...new Set([...(cfg().membersOnly || []), slug])];
      next.memberWebIds = { ...(cfg().memberWebIds || {}), [slug]: [...(cfg().moderatorWebIds || [])] };
      next.reprovision = true;
    }
    await save(next);
    return { category: slug, private: priv };
  }

  if (t === 'Update' && object && typeof object === 'object') {
    const id = idOf(object);
    const name = typeof object.name === 'string' ? object.name.trim().slice(0, 200) : '';
    if (same(forum, id, site.actor)) {
      if (!name) return {};
      await save({ name, republish: true });
      return { forum: name };
    }
    const cat = forum.categories.find(c => same(forum, c.urls.actor, id));
    if (!cat) return {};
    const out = {};
    if (name) {
      await save({ categories: (cfg().categories || []).map(c => (c.slug === cat.slug ? { ...c, name } : c)), republish: true });
      out.category = cat.slug;
      out.name = name;
    }
    // Open or private is the forum's OWN setting, and this is the only thing
    // that changes it: not who joins, not who is named a member, not how many
    // of either there are. AS2 already says it on a Group — a private
    // category approves each join — so `manuallyApprovesFollowers` is the
    // word for it, and the actor the forum publishes carries the same one.
    if ('manuallyApprovesFollowers' in object) {
      const priv = object.manuallyApprovesFollowers === true;
      const closed = new Set(cfg().membersOnly || []);
      if (priv) closed.add(cat.slug); else closed.delete(cat.slug);
      // Turning a category private with nobody named yet leaves its
      // moderators able to read it: a category nobody can read is a category
      // nobody can moderate.
      const named = { ...(cfg().memberWebIds || {}) };
      if (priv && !(named[cat.slug] || []).length) named[cat.slug] = [...(cfg().moderatorWebIds || [])];
      await save({
        membersOnly: [...closed], memberWebIds: named,
        categories: (cfg().categories || []).map(c => (c.slug === cat.slug ? { ...c, private: priv } : c)),
        republish: true, reprovision: true,
      });
      out.category = cat.slug;
      out.private = priv;
    }
    return out;
  }

  const who = idOf(object);
  if ((t === 'Add' || t === 'Remove') && who) {
    const on = t === 'Add';
    // Who moderates: an actor id, which is what the wire and FEP-1b12 use.
    const cat = forum.categories.find(c => same(forum, target, c.urls.moderators) || same(forum, target, c.urls.members));
    if (same(forum, target, site.administrators) || (cat && same(forum, target, cat.urls.moderators))) {
      const held = new Set(cfg().moderators || []);
      if (on) held.add(who); else held.delete(who);
      await save({ moderators: [...held], republish: true });
      // The forum's own list is what the website reads, so it is written now
      // rather than at the next start.
      await forum.republishAdministrators?.().catch(() => {});
      return { moderators: held.size };
    }
    // Who may read a members-only category, and who may read the queue: a
    // WebID, because only a WebID can be named in a pod's own access rule.
    // A member named by their Fediverse actor rather than their WebID: what
    // a moderator has in front of them when they admit a join request. The
    // WebID is the pod the actor lives on, checked against that pod's own
    // profile before it is granted anything.
    if (cat && same(forum, target, cat.urls.members) && !/#|\/profile\//u.test(who)) {
      const webid = await forum.webIdOf(who).catch(() => null);
      if (!webid) throw new Error(`no WebID could be found for ${who}`);
      return applySettings(forum, { ...activity, object: webid });
    }
    if (cat && same(forum, target, cat.urls.members)) {
      const named = { ...(cfg().memberWebIds || {}) };
      const held = new Set(named[cat.slug] || []);
      if (on) held.add(who); else held.delete(who);
      named[cat.slug] = [...held];
      // Naming a member says NOTHING about whether the category is open or
      // private. That is the forum's own setting and only an Update changes
      // it; in an open category this list simply sits there unused.
      await save({ memberWebIds: named, republish: true, reprovision: true });
      return { category: cat.slug, members: held.size };
    }
    // Who may read the queue, named the way every moderator is named: by
    // their Fediverse actor. The rule that holds the queue is the pod's own
    // and can only name a WebID, so the pod behind the actor is looked up
    // here; an account with no pod cannot be granted it at all.
    if (same(forum, target, site.mod) && !/#|\/profile\//u.test(who)) {
      const webid = await forum.webIdOf(who).catch(() => null);
      if (!webid) throw new Error(`no WebID could be found for ${who}`);
      return applySettings(forum, { ...activity, object: webid });
    }
    if (same(forum, target, site.mod)) {
      const held = new Set(cfg().moderatorWebIds || []);
      if (on) held.add(who); else held.delete(who);
      await save({ moderatorWebIds: [...held], republish: true, reprovision: true });
      return { moderatorWebIds: held.size };
    }
  }
  return {};
}
