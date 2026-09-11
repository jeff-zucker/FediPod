// polls.mjs — the count behind a Question.
//
// A poll travels as a Question whose options live in `oneOf` (pick one) or
// `anyOf` (pick several). A vote is not a special activity: it arrives as an
// ordinary reply carrying the option's `name` and no content. So the fediverse
// carries the votes and the author's server keeps the count — which means when
// the poll is ours, the roster of who chose what is ours to hold.
//
// Everything here is pure. The roster is a plain object the caller stores and
// hands back; the tallies are always DERIVED from it rather than kept beside
// it, so a count cannot drift away from the votes it is meant to summarize.

import crypto from 'node:crypto';

/** Where the roster lives in agent state. */
export const VOTES_DOC = 'poll-votes.json';

// What a poll may be. These are Mastodon's own limits, and they are the ones
// clients read out of the instance document to draw their poll composer, so a
// number we chose differently would be a number the composer then lets someone
// exceed. They live here rather than beside the client API because every way
// in has to honour them: an option is matched BY NAME when the vote comes
// back, so a long title is one something else in the network may truncate and
// hand back unrecognizable.
export const MAX_OPTIONS = 4;
export const MAX_OPTION_CHARS = 50;
export const MIN_SECONDS = 5 * 60;
export const MAX_SECONDS = 2629746;          // a month, as Mastodon counts one

// A voter is recorded as a hash of their actor id rather than the id itself.
// The roster is rewritten on every vote inside a document we serialize whole,
// and a poll that travels would otherwise grow a list of everyone who took
// part. The hash is stable, which is all a duplicate check needs.
export function voterKey(actor) {
  return crypto.createHash('sha256').update(String(actor)).digest('hex').slice(0, 16);
}

/**
 * Does this note have the shape of a vote? A name, and no content: that is the
 * whole convention. Anything carrying prose is a reply somebody wrote, and
 * swallowing it into a tally would lose it.
 */
export function isVoteShape(note) {
  if (!note?.name || typeof note.name !== 'string') return false;
  const text = String(note.content ?? '').replace(/<[^>]*>/gu, '').trim();
  return text === '';
}

/** Which option is this the name of? -1 when it names none of them. */
export function optionIndex(poll, name) {
  const opts = poll?.options || [];
  return opts.findIndex(o => o.title === String(name));
}

/** Closed outright, or past its end time. */
export function pollClosed(poll, now = Date.now()) {
  if (!poll) return false;
  if (poll.closed) return true;
  return !!poll.expiresAt && Date.parse(poll.expiresAt) <= now;
}

/**
 * Record one choice. Returns the roster to store and whether anything changed
 * — an unchanged roster must not cost a rewrite of the Question, which is the
 * one expense a busy poll can run up on the pod.
 *
 * A single-choice poll takes the first answer and ignores the rest, which is
 * how a voter changing their mind is refused rather than counted twice. A
 * multiple-choice poll unions the answers, because each choice arrives as its
 * own reply.
 */
export function addVote(roster, key, index, { multiple = false } = {}) {
  const had = roster[key] || [];
  if (had.length && !multiple) return { roster, changed: false };
  if (had.includes(index)) return { roster, changed: false };
  return { roster: { ...roster, [key]: [...had, index] }, changed: true };
}

/**
 * The counts, derived. `votes` is answers given, `voters` is people who gave
 * them — the same number until a poll takes several answers each.
 */
export function tallyOf(roster, optionCount) {
  const counts = new Array(optionCount).fill(0);
  let voters = 0;
  for (const picks of Object.values(roster || {})) {
    let counted = false;
    for (const i of picks) {
      if (i >= 0 && i < optionCount) { counts[i]++; counted = true; }
    }
    if (counted) voters++;
  }
  return { counts, voters, votes: counts.reduce((n, c) => n + c, 0) };
}

/** The poll record with its counts brought up to date from the roster. */
export function withTally(poll, roster) {
  const opts = poll?.options || [];
  const { counts, voters } = tallyOf(roster, opts.length);
  return {
    ...poll,
    options: opts.map((o, i) => ({ ...o, votes: counts[i] })),
    votersCount: voters,
  };
}
