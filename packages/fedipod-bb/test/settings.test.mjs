// settings.test.mjs — what changes a category's settings, and what does not.
// The rule this file exists for: OPEN or PRIVATE is the forum's own setting.
// Naming a member does not close a category, and unnaming the last one does
// not open it; only the forum saying so changes it.
//   node --test packages/fedipod-bb/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { forumUrls } from '../src/urls.mjs';
import { applySettings } from '../src/settings.mjs';

const POD = 'https://forum.example/';
const PRIYA_WEBID = 'https://priya.pod.example/profile/card#me';
const MEI_WEBID = 'https://mei.pod.example/profile/card#me';

// A forum as `applySettings` sees it: its names, its categories, and a config
// it can read and write.
function forum(config = {}) {
  const site = forumUrls(POD, 'fedipod-bb/');
  const held = { kind: 'application', handle: 'forum', categories: [{ slug: 'general', name: 'General' }],
    moderators: [], moderatorWebIds: [PRIYA_WEBID], membersOnly: [], memberWebIds: {}, ...config };
  const f = {
    site,
    store: { getConfig: () => f.config, setConfig: (c) => { f.config = c; } },
    config: held,
    categories: [{ slug: 'general', urls: site.category('general') }],
    webIdOf: async () => MEI_WEBID,
  };
  return f;
}
const isPrivate = (f, slug = 'general') => (f.config.membersOnly || []).includes(slug);

test('naming a member leaves an open category open, and dropping the last one leaves it as it was', async () => {
  const f = forum();
  const members = f.categories[0].urls.members;

  await applySettings(f, { type: 'Add', object: MEI_WEBID, target: members });
  assert.deepEqual(f.config.memberWebIds.general, [MEI_WEBID]);
  assert.equal(isPrivate(f), false, 'naming a member must not close the category');

  await applySettings(f, { type: 'Remove', object: MEI_WEBID, target: members });
  assert.deepEqual(f.config.memberWebIds.general, []);
  assert.equal(isPrivate(f), false);
});

test('the forum says open or private, and that is the only thing that says it', async () => {
  const f = forum();
  const actor = f.categories[0].urls.actor;

  const closed = await applySettings(f, { type: 'Update', object: { id: actor, manuallyApprovesFollowers: true } });
  assert.deepEqual(closed, { category: 'general', private: true });
  assert.equal(isPrivate(f), true);
  // Private with nobody named yet still leaves its moderators able to read it.
  assert.deepEqual(f.config.memberWebIds.general, [PRIYA_WEBID]);
  assert.equal(f.config.categories.find(c => c.slug === 'general').private, true);
  assert.equal(f.config.reprovision, true);

  // Members come and go; the category stays private.
  await applySettings(f, { type: 'Add', object: MEI_WEBID, target: f.categories[0].urls.members });
  assert.equal(isPrivate(f), true);
  await applySettings(f, { type: 'Remove', object: MEI_WEBID, target: f.categories[0].urls.members });
  await applySettings(f, { type: 'Remove', object: PRIYA_WEBID, target: f.categories[0].urls.members });
  assert.equal(isPrivate(f), true, 'a private category with nobody named is still private');

  const open = await applySettings(f, { type: 'Update', object: { id: actor, manuallyApprovesFollowers: false } });
  assert.deepEqual(open, { category: 'general', private: false });
  assert.equal(isPrivate(f), false);
  assert.equal(f.config.categories.find(c => c.slug === 'general').private, false);
});

test('a name and a privacy change are each their own change, and can arrive together', async () => {
  const f = forum();
  const actor = f.categories[0].urls.actor;
  const both = await applySettings(f, { type: 'Update', object: { id: actor, name: 'Everything else', manuallyApprovesFollowers: true } });
  assert.deepEqual(both, { category: 'general', name: 'Everything else', private: true });
  assert.equal(f.config.categories.find(c => c.slug === 'general').name, 'Everything else');
  assert.equal(isPrivate(f), true);

  // A rename on its own says nothing about privacy.
  await applySettings(f, { type: 'Update', object: { id: actor, name: 'General' } });
  assert.equal(isPrivate(f), true);
});

// ── the other half: what a member's own browser writes on their own pod ──

import * as priv from '../site/private.mjs';

test('a private post gets a container of its own and a rule naming the category\'s readers', () => {
  const where = priv.placeFor('https://fedipod.net/u/software/ap/actor');
  assert.equal(where, 'ap/private/fedipod-net-software/');
  // Two categories of one forum never share a rule, and neither do two forums.
  assert.notEqual(where, priv.placeFor('https://fedipod.net/u/general/ap/actor'));
  assert.notEqual(where, priv.placeFor('https://other.example/u/software/ap/actor'));

  const doc = priv.aclDoc('https://mei.pod/ap/private/x/', MEI_WEBID, [PRIYA_WEBID, 'https://forum.example/profile/card#me']);
  assert.match(doc, /acl:agent <https:\/\/mei\.pod\.example\/profile\/card#me>/u);
  assert.match(doc, /acl:mode acl:Read, acl:Write, acl:Control/u);
  assert.equal((doc.match(/acl:mode acl:Read\./gu) || []).length, 2, 'each named reader reads, and only reads');
  assert.match(doc, /acl:default <https:\/\/mei\.pod\/ap\/private\/x\/>/u, 'the rule covers the posts in it, not just the container');
});

test('nothing but an http address ever reaches an access rule', () => {
  const bad = ['javascript:alert(1)', 'https://a.pod/x> .\n<#evil> a acl:Authorization', 'not a url', ''];
  for (const who of bad) {
    const doc = priv.aclDoc('https://mei.pod/ap/private/x/', MEI_WEBID, [who, PRIYA_WEBID]);
    assert.equal((doc.match(/acl:Authorization/gu) || []).length, 2, `${who} is not written into the rule`);
  }
  assert.throws(() => priv.aclDoc('https://mei.pod/x/', 'javascript:x', []), /usable WebID/u);
});

test('who may read, as the category answers: a list, a refusal, or no list at all', async () => {
  const answer = (status, body) => ({ fetch: async () => ({ status, ok: status < 300, json: async () => body }) });
  assert.equal(await priv.readersOf('https://f.example/c/x/', answer(404)), null, 'no list means the category is open');
  assert.deepEqual(await priv.readersOf('https://f.example/c/x/', answer(403)), [], 'refused means private and not yours');
  assert.deepEqual(
    await priv.readersOf('https://f.example/c/x/', answer(200, { orderedItems: [MEI_WEBID, 'javascript:no'] })),
    [MEI_WEBID], 'and a list is only ever addresses');
});
