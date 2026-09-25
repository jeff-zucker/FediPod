// A tiny public pod for manual SSR and browser smoke checks.
import http from 'node:http';
import { createHash } from 'node:crypto';

const base = 'http://127.0.0.1:4099/';
const actor = base + 'c/g/ap/actor';
const post = base + 'posts/1';
const topic = base + 'c/g/ap/topic/one';
const copy = 'c/g/ap/cache/' + createHash('sha256').update(post).digest('hex').slice(0, 16);
const docs = {
  'ap/actor': { id: base + 'ap/actor', name: 'Test Forum', preferredUsername: 'test' },
  'ap/categories': { orderedItems: [actor] },
  'c/g/ap/actor': { id: actor, name: 'Gardening', preferredUsername: 'g' },
  'c/g/ap/followers': { totalItems: 2 },
  'ap/latest': { orderedItems: [base + copy] },
  [copy]: { id: post, type: 'Note', attributedTo: base + 'people/mei', content: '<p>Hello plants</p>', published: '2026-09-24T10:00:00Z', context: topic, audience: actor },
  'c/g/ap/topic/one': { id: topic, name: 'Tomatoes', totalItems: 1, first: topic + '-1' },
  'c/g/ap/topic/one-1': { orderedItems: [post] },
};

http.createServer((req, res) => {
  const doc = docs[decodeURIComponent(req.url.slice(1))];
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/activity+json');
  res.statusCode = doc ? 200 : 404;
  res.end(JSON.stringify(doc || {}));
}).listen(4099, '127.0.0.1');
