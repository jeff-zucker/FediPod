  // questions.mjs — polls.
  //
  // A poll is published as a Question and answered by ordinary replies naming
  // an option, so the count is ours to keep and ours to republish. The roster
  // of who chose what lives in agent state (polls.VOTES_DOC); the tallies on
  // the status row and in the pod document are always derived from it.

import crypto from 'node:crypto';
import * as wire from '../wire.mjs';
import * as polls from '../polls.mjs';
import * as podNotes from '../../pod/notes.mjs';

// How long a poll gathers votes before its Question is rewritten. Every vote
// changes a number other servers re-read, and rewriting per vote would make a
// busy poll a steady write stream against the pod. A burst costs one rewrite
// and one Update instead.
const POLL_REWRITE_MS = 10_000;

/**
 * Publish a poll. `options` is a list of choice titles, `multiple` lets a
 * voter pick more than one, and `expiresAt` is when voting stops.
 */
export async function publishQuestion(publisher, content, { options = [], multiple = false, expiresAt = null,
  inReplyTo = undefined, visibility = 'public', spoilerText = null } = {}) {
  const { urls } = publisher;
  const priv = visibility === 'private' || visibility === 'direct';
  if (priv) {
    const ready = await publisher.privateReady();
    if (ready !== true) throw new Error(ready);
  }
  const titles = [].concat(options).map(o => String(o ?? '').trim()).filter(Boolean);
  if (titles.length < 2) throw new Error('a poll needs at least two options');
  // Options are matched BY NAME when a vote arrives — that is the whole of
  // the convention — so two options reading the same are one option that
  // cannot be told apart.
  if (new Set(titles).size !== titles.length) throw new Error('a poll’s options must differ from one another');
  // Bounded here as well as at the client API, because the outbox is a
  // second way in and an unbounded poll is a document a stranger sizes.
  if (titles.length > polls.MAX_OPTIONS) throw new Error(`a poll takes at most ${polls.MAX_OPTIONS} options`);
  if (titles.some(t => t.length > polls.MAX_OPTION_CHARS)) {
    throw new Error(`a poll option is at most ${polls.MAX_OPTION_CHARS} characters`);
  }
  if (expiresAt) {
    const ends = Date.parse(expiresAt);
    if (!Number.isFinite(ends)) throw new Error('the closing time is not a date');
    const seconds = (ends - Date.now()) / 1000;
    if (seconds < polls.MIN_SECONDS || seconds > polls.MAX_SECONDS) {
      throw new Error(`a poll runs between ${polls.MIN_SECONDS} and ${polls.MAX_SECONDS} seconds`);
    }
  }

  const published = new Date().toISOString();
  const slug = published.slice(0, 10) + '-' + crypto.randomBytes(4).toString('hex');
  const mentions = await publisher._mentionsFor(content, inReplyTo);
  const poll = {
    multiple: !!multiple,
    expiresAt: expiresAt || null,
    closed: null,
    options: titles.map(title => ({ title, votes: 0 })),
    votersCount: 0,
    // Resolved once, here: a tally rewrite must not cost a webfinger lookup
    // per vote for people the poll named.
    mentionInboxes: [...new Set(mentions.map(m => m.inbox).filter(Boolean))],
  };
  const question = wire.questionDoc({
    urls, slug, content, published, inReplyTo, attachments: [], mentions,
    visibility, summary: spoilerText,
    container: priv ? urls.privateNotes : urls.notes,
    options: poll.options, multiple: poll.multiple, endTime: poll.expiresAt, votersCount: 0,
  });

  await podNotes.write(publisher.remote, question.id, question);
  // Empty, but present: a dangling `replies` that 404s is worse than none.
  await podNotes.writeEmptyReplies(publisher.remote, wire.repliesId(question.id),
    wire.collection(wire.repliesId(question.id), []));
  if (!priv) await publisher.recordOutbox(question.id);
  publisher.store.addStatus({
    noteId: question.id, actor: urls.actor, content: question.content, published,
    kind: 'post', slug, text: content, visibility, poll, inReplyTo,
    ...(spoilerText ? { spoiler: spoilerText } : {}),
    ...(question.tag?.length ? { mentions: question.tag.map(t => ({ href: t.href, name: t.name })) } : {}),
  });

  const create = publisher._pollActivity('Create', question, wire.createActivityId(question.id));
  await podNotes.writeCreate(publisher.remote, create.id, create);
  const contacts = publisher.store.getContacts();
  const inboxes = [...new Set([
    ...(visibility === 'direct' ? [] : contacts.followers.map(f => f.sharedInbox || f.inbox)),
    ...poll.mentionInboxes,
  ].filter(Boolean))];
  await publisher.deliverer.deliverToAll(inboxes, create);
  publisher.log(`poll published: ${question.id} (${titles.length} options) → ${inboxes.length} inbox(es)`);
  return question;
}

// The Create or Update carrying a Question. The context is hoisted onto the
// activity and the embedded object keeps none: a nested @context is legal
// JSON-LD but not every server reads one, and votersCount is declared there.
export function pollActivity(publisher, type, question, id) {
  const { '@context': ctx, ...object } = question;
  return {
    '@context': ctx, id, type,
    actor: publisher.urls.actor,
    published: question.published,
    to: question.to, cc: question.cc,
    object,
  };
}

/**
 * One vote on one of OUR polls, named by the option's title. Returns true
 * when it counted — a second answer to a single-choice poll, an option we do
 * not offer, or a poll that has closed all count for nothing.
 */
export async function recordVote(publisher, questionId, actor, optionName) {
  const s = publisher.store.getStatuses().find(x => x.noteId === questionId);
  if (!s?.poll || s.kind !== 'post' || s.actor !== publisher.urls.actor) return false;
  if (polls.pollClosed(s.poll)) return false;
  const index = polls.optionIndex(s.poll, optionName);
  if (index < 0) return false;
  const all = publisher.store.read(polls.VOTES_DOC, {});
  const { roster, changed } = polls.addVote(all[questionId] || {}, polls.voterKey(actor), index,
    { multiple: !!s.poll.multiple });
  if (!changed) return false;
  publisher.store.write(polls.VOTES_DOC, { ...all, [questionId]: roster });
  publisher.store.updateStatus(questionId, { poll: polls.withTally(s.poll, roster) });
  publisher._pollDirty(questionId);
  return true;
}

// Open the rewrite window for a poll whose count moved. Already open is
// already enough: the whole point is that a burst costs one rewrite.
export function pollDirty(publisher, questionId) {
  if (publisher.pollTimers.has(questionId)) return;
  const t = setTimeout(() => {
    publisher.pollTimers.delete(questionId);
    publisher.republishPoll(questionId).catch(e => publisher.log(`poll rewrite: ${e.message}`));
  }, POLL_REWRITE_MS);
  t.unref?.();
  publisher.pollTimers.set(questionId, t);
}

/**
 * Write the poll's current count back to the pod and tell everyone who has
 * it. `closing` stamps it shut, which is a one-way door.
 */
export async function republishPoll(publisher, questionId, { closing = null } = {}) {
  const s = publisher.store.getStatuses().find(x => x.noteId === questionId);
  if (!s?.poll) return null;
  const { urls } = publisher;
  const roster = publisher.store.read(polls.VOTES_DOC, {})[questionId] || {};
  // A shut poll whose roster has been retired keeps the counts on its row:
  // deriving them from an empty roster would publish a poll nobody voted in.
  const shut = closing || s.poll.closed;
  const counted = shut && !Object.keys(roster).length ? s.poll : polls.withTally(s.poll, roster);
  const poll = { ...counted, ...(closing ? { closed: closing } : {}) };
  const container = String(s.noteId).startsWith(urls.privateNotes) ? urls.privateNotes : urls.notes;
  const slug = s.slug || String(s.noteId).slice(container.length);
  const mentions = (s.mentions || []).map(m => ({
    handle: String(m.name || '').replace(/^@/, ''), actor: m.href, page: null, inbox: null,
  }));
  const question = wire.questionDoc({
    urls, slug, content: s.text ?? '', published: s.published, inReplyTo: s.inReplyTo,
    attachments: [], mentions,
    visibility: s.visibility || 'public', summary: s.spoiler || null, container,
    options: poll.options, multiple: !!poll.multiple, endTime: poll.expiresAt,
    closed: poll.closed, votersCount: poll.votersCount || 0,
  });
  await podNotes.write(publisher.remote, question.id, question);
  // The Create is overwritten too, so a group's Announce resolves to the
  // current count rather than to the one the poll opened with.
  await podNotes.writeCreate(publisher.remote, wire.createActivityId(question.id),
    publisher._pollActivity('Create', question, wire.createActivityId(question.id)));
  publisher.store.updateStatus(questionId, { poll });

  // Not `updated`: a changed count is not an edit, and stamping one would
  // have every client show the poll as edited each time somebody voted.
  //
  // The Update is named after the STATE it carries rather than the moment it
  // was sent. A clock only tells two rewrites apart when they fall in
  // different milliseconds, and a receiving server that has seen an activity
  // id drops the next one wearing it — which would quietly freeze the count.
  // Naming the state means an id changes exactly when there is something new
  // to say, and two sends of the same numbers are the duplicate they look
  // like.
  const stamp = crypto.createHash('sha256').update(JSON.stringify([
    poll.options.map(o => o.votes || 0), poll.votersCount || 0, poll.closed || '',
  ])).digest('hex').slice(0, 12);
  const update = publisher._pollActivity('Update', question, `${question.id}#poll-${stamp}`);
  const contacts = publisher.store.getContacts();
  const inboxes = [...new Set([
    ...(s.visibility === 'direct' ? [] : contacts.followers.map(f => f.sharedInbox || f.inbox)),
    ...(s.poll.mentionInboxes || []),
  ].filter(Boolean))];
  await publisher.deliverer.deliverToAll(inboxes, update);
  publisher.log(`poll ${closing ? 'closed' : 'count published'}: ${question.id} → ${inboxes.length} inbox(es)`);
  return poll;
}

/**
 * Shut any poll whose time is up. Called from the agent's sweep. Closing is
 * recorded BEFORE the republish, so a failed republish cannot leave a poll
 * open and collecting votes it has already refused.
 */
export async function closeDuePolls(publisher, now = Date.now()) {
  const due = publisher.store.getStatuses().filter(s => s.kind === 'post' && s.poll
    && !s.poll.closed && s.poll.expiresAt && Date.parse(s.poll.expiresAt) <= now);
  for (const s of due) {
    const closed = new Date(Math.min(now, Date.parse(s.poll.expiresAt) || now)).toISOString();
    clearTimeout(publisher.pollTimers.get(s.noteId));
    publisher.pollTimers.delete(s.noteId);
    publisher.store.updateStatus(s.noteId, { poll: { ...s.poll, closed } });
    const done = await publisher.republishPoll(s.noteId, { closing: closed })
      .catch(e => { publisher.log(`poll close ${s.noteId}: ${e.message}`); return null; });
    // The roster only ever answered one question — has this person already
    // voted — and a shut poll has stopped asking it. Dropping it keeps a
    // document we serialize whole from carrying every poll's voters forever.
    if (done) {
      const all = publisher.store.read(polls.VOTES_DOC, {});
      if (all[s.noteId]) {
        delete all[s.noteId];
        publisher.store.write(polls.VOTES_DOC, all);
      }
    }
  }
  return due.length;
}

/** Stop the pending rewrite windows. Called at shutdown. */
export function stopPolls(publisher) {
  for (const t of publisher.pollTimers.values()) clearTimeout(t);
  publisher.pollTimers.clear();
}
