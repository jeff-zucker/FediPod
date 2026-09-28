// forum-signup-form.test.mjs — what the sign-up page's forum fields are read into.
import test from 'node:test';
import assert from 'node:assert/strict';
import { categoriesFrom, moderatorFrom } from '../../web/app/forum-form.mjs';

test('categories: one per line, short name then the name readers see', () => {
  assert.deepEqual(categoriesFrom('general: General Discussion\nsoftware\n\n  Tools : Tools and Tips  '),
    [{ slug: 'general', name: 'General Discussion' }, { slug: 'software', name: 'software' }, { slug: 'tools', name: 'Tools and Tips' }]);
  assert.throws(() => categoriesFrom(''), /at least one/u);
  assert.throws(() => categoriesFrom('General Discussion'), /not a short name/u);
  assert.throws(() => categoriesFrom('a: A\na: Again'), /listed twice/u);
});

test('moderator: an address at this site becomes its actor; elsewhere is refused with a way forward; empty is nobody', () => {
  assert.equal(moderatorFrom('', 'https://fedipod.example'), null);
  assert.equal(moderatorFrom('@Jeff@fedipod.example', 'https://fedipod.example'), 'https://fedipod.example/u/jeff/ap/actor');
  assert.equal(moderatorFrom('jeff@fedipod.example', 'https://fedipod.example'), 'https://fedipod.example/u/jeff/ap/actor');
  assert.equal(moderatorFrom('https://elsewhere.example/users/jeff', 'https://fedipod.example'), 'https://elsewhere.example/users/jeff');
  assert.throws(() => moderatorFrom('@jeff@elsewhere.example', 'https://fedipod.example'), /settings page/u);
  assert.throws(() => moderatorFrom('not an address', 'https://fedipod.example'), /@name@server/u);
});
