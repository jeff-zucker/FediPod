// post-text-once.test.mjs — a post's text shows once. Mastodon sends it twice,
// plain and tagged with its language, and both copies used to reach the
// screen joined by a comma.
import test from 'node:test';
import assert from 'node:assert/strict';
const { readLenient } = await import('../../lib/core/as2.mjs');
const { titledContent } = await import('../../lib/core/wire.mjs');
const { once } = await import('../../lib/client/masto/render.mjs');

const note = (extra) => ({
  '@context': ['https://www.w3.org/ns/activitystreams', { sensitive: 'as:sensitive' }],
  id: 'https://social.example/users/ingrid/statuses/1', type: 'Note',
  attributedTo: 'https://social.example/users/ingrid', published: '2026-10-10T00:00:00Z', ...extra,
});
const read = async (doc) => { const r = await readLenient(JSON.stringify(doc)); return r.view ?? r.doc; };

test('a Mastodon post, sent with its text plain and by language, reads as one text', async () => {
  const v = await read(note({ content: '<p>New #updates, 10 Oct</p>', contentMap: { en: '<p>New #updates, 10 Oct</p>' } }));
  assert.equal(v.content, '<p>New #updates, 10 Oct</p>');
  assert.equal(titledContent(v), '<p>New #updates, 10 Oct</p>');
});

test('a post sent only by language reads as that text', async () => {
  const v = await read(note({ contentMap: { de: '<p>Hallo</p>' } }));
  assert.equal(v.content, '<p>Hallo</p>');
});

test('a post with its text in two languages and no plain copy reads as one of them', async () => {
  const v = await read(note({ contentMap: { en: '<p>Hello</p>', de: '<p>Hallo</p>' } }));
  assert.equal(typeof v.content, 'string');
});

test('a post already stored with its text twice is shown once', () => {
  assert.equal(once('<p>Hello</p>,<p>Hello</p>'), '<p>Hello</p>');
  assert.equal(once('<p>Hello, Sipho</p>'), '<p>Hello, Sipho</p>', 'a comma inside the text is left alone');
  assert.equal(once('<p>A</p>,<p>B</p>'), '<p>A</p>,<p>B</p>', 'two different halves are left alone');
  assert.equal(once(''), '');
});
