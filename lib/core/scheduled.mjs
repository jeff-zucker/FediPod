// scheduled.mjs — what falls due while nobody is looking: scheduled posts
// whose time has come, and polls whose voting has ended. Any agent that is
// running when something falls due does it: the owner's app while it is open,
// the gateway's keeper while it is closed (lib/gateway/keeper.mjs), a
// DeviceAgent always.
//
// A scheduled post is taken off the list before it is published, so a slow
// publish cannot post twice; one that fails is dropped, with its reason in the
// log. A poll is shut and everyone holding it is told once
// (publisher/questions.mjs: closeDuePolls).

/** Publish what has fallen due. Returns how many scheduled posts went out. */
export async function publishDue(store, publisher, log = () => {}, now = Date.now()) {
  const due = store.getScheduled().filter((e) => Date.parse(e.scheduledAt) <= now);
  for (const e of due) {
    store.setScheduled(store.getScheduled().filter((x) => x.id !== e.id));
    await publisher.publishNote(e.params.status, {
      inReplyTo: e.params.inReplyTo, attachments: e.params.attachments,
      visibility: e.params.visibility, spoilerText: e.params.spoilerText,
    }).then(() => log(`scheduled post published (${e.id})`))
      .catch((err) => log(`scheduled post ${e.id} failed: ${err.message} — dropped`));
  }
  await publisher.closeDuePolls(now).catch((err) => log(`closing polls: ${err.message}`));
  return due.length;
}

/**
 * When the next thing falls due, or null when nothing is waiting: a scheduled
 * post, a poll's end, or another try at a delivery that failed.
 */
export function nextDue(store) {
  const at = [
    ...store.getScheduled().map((e) => Date.parse(e.scheduledAt)),
    ...(store.getStatuses?.() || []).filter((s) => s.kind === 'post' && s.poll && !s.poll.closed && s.poll.expiresAt)
      .map((s) => Date.parse(s.poll.expiresAt)),
    ...(store.getQueue?.() || []).map((q) => Number(q.nextAt)),
  ].filter(Number.isFinite);
  return at.length ? new Date(Math.min(...at)).toISOString() : null;
}
