// doc-delta.test.mjs — what changed in a state document, and applying it to
// another copy (lib/core/doc-delta.mjs).
// Run from the project root: node --test claude/smoke-tests/doc-delta.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { deltaOf, applyDelta } from '../../lib/core/doc-delta.mjs';

const roundTrip = (before, after, other = before) => applyDelta(structuredClone(other), deltaOf(before, after));

test('nothing changed is no change', () => {
  assert.equal(deltaOf([{ noteId: 'a' }], [{ noteId: 'a' }]), null);
  assert.equal(deltaOf({ x: 1 }, { x: 1 }), null);
});

test('a new post at the top of the timeline lands at the top of the other copy', () => {
  const before = [{ noteId: 'b', content: 'old' }, { noteId: 'a', content: 'older' }];
  const after = [{ noteId: 'c', content: 'new' }, ...before];
  const pod = [{ noteId: 'z', content: 'only on the pod' }, ...before];
  assert.deepEqual(roundTrip(before, after, pod).map((s) => s.noteId), ['c', 'z', 'b', 'a']);
});

test('a changed record is changed in place, a removed one removed', () => {
  const before = [{ noteId: 'b', bookmarked: false }, { noteId: 'a' }];
  const after = [{ noteId: 'b', bookmarked: true }];
  assert.deepEqual(roundTrip(before, after), [{ noteId: 'b', bookmarked: true }]);
});

test('a record added to a document the sender never had still lands', () => {
  const d = deltaOf(null, [{ id: 'n1', type: 'follow' }]);
  const pod = [{ id: 'n0', type: 'favourite' }];
  assert.deepEqual(applyDelta(pod, d).map((n) => n.id), ['n1', 'n0']);
  assert.deepEqual(applyDelta(null, d).map((n) => n.id), ['n1']);
});

test('a changed record the other copy lacks is added', () => {
  const d = deltaOf([{ noteId: 'a', x: 1 }], [{ noteId: 'a', x: 2 }]);
  assert.deepEqual(applyDelta([], d), [{ noteId: 'a', x: 2 }]);
});

test('an object is changed key by key', () => {
  const before = { 'https://a.example/actor': { name: 'A' }, 'https://b.example/actor': { name: 'B' } };
  const after = { 'https://a.example/actor': { name: 'A2' }, 'https://c.example/actor': { name: 'C' } };
  const pod = { ...before, 'https://d.example/actor': { name: 'D' } };
  const d = deltaOf(before, after);
  assert.deepEqual(Object.keys(d.set).sort(), ['https://a.example/actor', 'https://c.example/actor']);
  assert.deepEqual(applyDelta(pod, d), {
    'https://a.example/actor': { name: 'A2' }, 'https://c.example/actor': { name: 'C' }, 'https://d.example/actor': { name: 'D' } });
});

test('a list of plain values is compared value by value', () => {
  const d = deltaOf(['h2', 'h1'], ['h3', 'h2', 'h1']);
  assert.deepEqual(applyDelta(['h2', 'h1', 'h0'], d), ['h3', 'h2', 'h1', 'h0']);
});

test('a list with no common field is sent whole', () => {
  const d = deltaOf([{ a: 1 }], [{ b: 2 }]);
  assert.deepEqual(d, { whole: [{ b: 2 }] });
  assert.deepEqual(applyDelta([{ c: 3 }], d), [{ b: 2 }]);
});

test('a document that changes kind is sent whole', () => {
  assert.deepEqual(roundTrip({ x: 1 }, [1, 2]), [1, 2]);
  assert.equal(roundTrip(1, 2), 2);
});

test('the same change applied twice changes nothing more', () => {
  const before = [{ noteId: 'a' }];
  const after = [{ noteId: 'b' }, { noteId: 'a' }];
  const d = deltaOf(before, after);
  assert.deepEqual(applyDelta(applyDelta(before, d), d), after);
});
