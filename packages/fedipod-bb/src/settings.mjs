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

// Which of these a delivered activity is, if any. The forum's own actor or
// one of its collections has to be named, or it is somebody else's business.
export function isSettingsAsk(forum, activity) {
  const t = activity?.type;
  const target = idOf(activity?.target);
  const object = activity?.object;
  const site = forum.site;
  if (t === 'Create' && object && typeof object === 'object' && object.type === 'Group') {
    return idOf(activity.target) === site.actor;
  }
  if (t === 'Update' && object && typeof object === 'object') {
    const id = idOf(object);
    return id === site.actor || forum.categories.some(c => c.urls.actor === id);
  }
  if (t === 'Add' || t === 'Remove') {
    if (!target) return false;
    if (target === site.administrators || target === site.mod) return true;
    return forum.categories.some(c => target === c.urls.moderators || target === c.urls.members);
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
  const save = (next) => { forum.store.setConfig({ ...cfg(), ...next }); forum.config = forum.store.getConfig(); };

  if (t === 'Create' && object?.type === 'Group') {
    const slug = String(object.preferredUsername || '').toLowerCase();
    if (!SLUG.test(slug)) throw new Error(`not a category slug: ${slug}`);
    const cats = cfg().categories || [];
    if (cats.some(c => c.slug === slug)) return { unchanged: slug };
    save({ categories: [...cats, { slug, name: String(object.name || slug).slice(0, 200) }], republish: true });
    return { category: slug };
  }

  if (t === 'Update' && object && typeof object === 'object') {
    const id = idOf(object);
    const name = typeof object.name === 'string' ? object.name.trim().slice(0, 200) : '';
    if (!name) return {};
    if (id === site.actor) { save({ name, republish: true }); return { forum: name }; }
    const cat = forum.categories.find(c => c.urls.actor === id);
    if (!cat) return {};
    save({ categories: (cfg().categories || []).map(c => (c.slug === cat.slug ? { ...c, name } : c)), republish: true });
    return { category: cat.slug, name };
  }

  const who = idOf(object);
  if ((t === 'Add' || t === 'Remove') && who) {
    const on = t === 'Add';
    // Who moderates: an actor id, which is what the wire and FEP-1b12 use.
    const cat = forum.categories.find(c => target === c.urls.moderators || target === c.urls.members);
    if (target === site.administrators || (cat && target === cat.urls.moderators)) {
      const held = new Set(cfg().moderators || []);
      if (on) held.add(who); else held.delete(who);
      save({ moderators: [...held], republish: true });
      return { moderators: held.size };
    }
    // Who may read a members-only category, and who may read the queue: a
    // WebID, because only a WebID can be named in a pod's own access rule.
    if (cat && target === cat.urls.members) {
      const named = { ...(cfg().memberWebIds || {}) };
      const held = new Set(named[cat.slug] || []);
      if (on) held.add(who); else held.delete(who);
      named[cat.slug] = [...held];
      const closed = new Set(cfg().membersOnly || []);
      if (on) closed.add(cat.slug);
      save({ memberWebIds: named, membersOnly: [...closed], republish: true, reprovision: true });
      return { category: cat.slug, members: held.size };
    }
    if (target === site.mod) {
      const held = new Set(cfg().moderatorWebIds || []);
      if (on) held.add(who); else held.delete(who);
      save({ moderatorWebIds: [...held], republish: true, reprovision: true });
      return { moderatorWebIds: held.size };
    }
  }
  return {};
}
