// channel.mjs — the inbox's push channel: a WebSocketChannel2023 subscription
// on the pod's inbox container, reconnecting with backoff, and the drain it
// wakes. State (ws, wsState, reconnectTries, resubTimer) lives on the Intake
// so status pages and stop() see it; this module is the behaviour.

import * as podNotifications from '../../pod/notifications.mjs';
import { USER_AGENT } from '../../shared/ua.mjs';
import { HTTP_TIMEOUT_MS, readCapped } from '../../shared/safefetch.mjs';
import { sameSocketOrigin } from './activity.mjs';

// The channel a subscription returns outlives a dropped socket, so reconnecting
// reuses it. Creating a new one per reconnect is what buried solidcommunity.net
// in channel records they then had to sweep.
const CHANNEL_DOC = 'inbox-channel.json';
// A flapping socket used to POST a NEW WebSocketChannel2023 channel every two
// seconds — hundreds an hour against a server that is already struggling, and
// channel churn its operators have to sweep up. Backs off instead, and an open
// only triggers a sweep if we have not just swept.
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 5 * 60_000;
// How long a socket must stay up before the backoff counts it as a success and
// resets. Shorter than that is a flap, not a connection.
const RECONNECT_STABLE_MS = 60_000;
const OPEN_DRAIN_MIN_GAP_MS = 30_000;

// Jittered exponential, floor to ceiling, reset by a successful open.
export function reconnectDelay(intake) {
  const capped = Math.min(RECONNECT_MIN_MS * 2 ** intake.reconnectTries, RECONNECT_MAX_MS);
  intake.reconnectTries++;
  return Math.round(capped * (0.8 + Math.random() * 0.4));
}

// --- push ---
// Any failure in here used to end push for the life of the process: the
// retry lived only in the "server refused the subscription" branch, so a
// network blip left wsState at never-connected and the agent silently on
// polling. Every path now schedules a retry on the same backoff.
export async function subscribe(intake) {
  try {
    await intake._subscribeOnce();
  } catch (e) {
    intake.wsState = 'subscribe-error';
    const wait = intake._reconnectDelay();
    intake.log(`subscribe failed (${e.message}) — retrying in ${Math.round(wait / 1000)}s (polling meanwhile)`);
    if (!intake.stopped) {
      intake.resubTimer = setTimeout(() => intake.subscribe().catch(() => {}), wait);
      intake.resubTimer.unref?.();
    }
  }
}

/**
 * Where this pod describes the services it offers. The pod says so on any
 * response about one of its resources; the well-known path is only what a
 * pod that says nothing has always used.
 */
export async function storageDescriptionUrl(intake) {
  return podNotifications.storageDescriptionUrl(intake.urls.base,
    { headers: { 'user-agent': USER_AGENT }, timeoutMs: HTTP_TIMEOUT_MS });
}

export async function subscribeOnce(intake) {
  // Reuse a channel we already have rather than asking for another one.
  const saved = intake.store.read(CHANNEL_DOC, null);
  if (saved?.receiveFrom && (!saved.endAt || Date.parse(saved.endAt) - Date.now() > 60_000)) {
    intake._openSocket(saved.receiveFrom, true);
    return;
  }
  const descUrl = await intake._storageDescriptionUrl();
  const { channel, error } = await podNotifications.readWebSocketChannel(descUrl,
    { headers: { 'user-agent': USER_AGENT }, timeoutMs: HTTP_TIMEOUT_MS });
  if (!channel) { intake.wsState = 'unavailable'; intake.log(`${error} — polling only`); return; }
  // The topic is a POD resource, and it travels in the BODY — so the url map
  // RemotePod applies to the request line never reaches it. A fronted
  // identity's inbox url names the front, which the pod cannot grant read on,
  // and the subscription came back 403. A no-op when unfronted.
  const topic = intake.urls.toPod ? intake.urls.toPod(intake.urls.inbox) : intake.urls.inbox;
  const sub = await podNotifications.subscribeToInbox(intake.remote,
    { channelUrl: channel, podTopicUrl: topic });
  const body = await readCapped(sub).then(JSON.parse).catch(() => null);
  if (!body?.receiveFrom) {
    intake.wsState = `subscribe-failed-${sub.status}`;
    const wait = intake._reconnectDelay();
    intake.log(`subscription failed (${sub.status}) — retrying in ${Math.round(wait / 1000)}s (polling meanwhile)`);
    if (!intake.stopped) {
      intake.resubTimer = setTimeout(() => intake.subscribe().catch(e => intake.log(`resubscribe: ${e.message}`)), wait);
      intake.resubTimer.unref?.();
    }
    return;
  }
  intake.store.write(CHANNEL_DOC, { receiveFrom: body.receiveFrom, endAt: body.endAt || null });
  intake._openSocket(body.receiveFrom, false);
}

// The socket URL arrives in the pod's own subscription response, and it was
// the one outbound address in the project that reached the network without
// passing anything — safefetch guards every fetch, and `new WebSocket()` is
// not a fetch. A pod that answered with somebody else's address had us open a
// long-lived connection there and treat what came back as our inbox waking up.
//
// Same origin as the pod, not assertPublicUrl: a pod on this machine is a
// documented setup and its socket is legitimately ws://localhost:3000, which
// a public-address check would refuse.
export function openSocket(intake, receiveFrom, reused) {
  if (!sameSocketOrigin(receiveFrom, intake.urls.base)) {
    intake.wsState = 'refused';
    intake.log(`subscription named ${receiveFrom}, which is not this pod — polling only`);
    if (reused) intake.store.write(CHANNEL_DOC, null);
    return;
  }
  intake.ws = new WebSocket(receiveFrom);
  intake.ws.onopen = () => {
    intake.wsState = 'open';
    if (!intake._announcedPush) { intake.log('inbox push subscription active'); intake._announcedPush = true; }
    intake._openedAt = Date.now();
    // Anything that arrived while the socket was down is waiting — sweep it,
    // unless a sweep just ran: a flapping socket must not re-list the inbox
    // on every open.
    if (Date.now() - intake.lastDrainAtMs > OPEN_DRAIN_MIN_GAP_MS) {
      intake.drain().catch(e => intake.log(`drain: ${e.message}`));
    }
  };
  intake.ws.onmessage = () => intake.drain().catch(e => intake.log(`drain: ${e.message}`));
  intake.ws.onclose = () => {
    intake.wsState = 'closed';
    // Only a connection that STAYED up counts as a success. Resetting on open
    // alone meant the 2026-07-29 failure — a server that accepts the upgrade
    // and then drops the socket on a crash cycle — reconnected at the 2s
    // floor indefinitely: every cycle "succeeded", so the exponential cap was
    // never reached, and each open also drained the inbox.
    if (intake._openedAt && Date.now() - intake._openedAt >= RECONNECT_STABLE_MS) intake.reconnectTries = 0;
    intake._openedAt = 0;
    if (!intake.stopped) {
      intake.resubTimer = setTimeout(() => intake.subscribe().catch(e => intake.log(`resubscribe: ${e.message}`)), intake._reconnectDelay());
      intake.resubTimer.unref?.();
    }
  };
  intake.ws.onerror = () => {
    intake.wsState = 'error';
    // A channel we reused may simply be gone: forget it so the next attempt
    // asks for a fresh one instead of retrying a dead URL forever.
    if (reused) intake.store.write(CHANNEL_DOC, null);
  };
}
