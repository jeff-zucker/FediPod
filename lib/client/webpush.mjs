// webpush.mjs — Mastodon-style Web Push from the agent itself. The VAPID
// keypair is minted once into state; each client login keeps one subscription;
// payloads go straight from this process to the browser's push service, so a
// closed client still hears about mentions. No relay, no third party account,
// and nothing here touches the pod.
import crypto from 'node:crypto';
import webpush from 'web-push';

export class Push {
  constructor({ store, subject, log = () => {} }) {
    this.store = store;
    this.subject = subject;             // () => the actor URL, VAPID's contact
    this.log = log;
  }

  state() { return this.store.read('webpush.json', { subs: {} }); }
  save(s) { this.store.write('webpush.json', s); }

  vapid() {
    const st = this.state();
    if (!st.vapid) {
      st.vapid = webpush.generateVAPIDKeys();
      this.save(st);
      this.log('webpush: VAPID keypair minted');
    }
    return st.vapid;
  }

  publicKey() { return this.vapid().publicKey; }

  // One subscription per client login, keyed by a hash of its bearer token —
  // the token itself is never written down twice.
  keyOf(token) { return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16); }

  get(token) { return this.state().subs[this.keyOf(token)] || null; }

  set(token, { endpoint, keys, alerts }) {
    if (!/^https:\/\//.test(String(endpoint || ''))) return null;
    if (!keys?.p256dh || !keys?.auth) return null;
    const st = this.state();
    st.subs[this.keyOf(token)] = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, alerts: alerts || {} };
    this.save(st);
    return st.subs[this.keyOf(token)];
  }

  setAlerts(token, alerts) {
    const st = this.state();
    const sub = st.subs[this.keyOf(token)];
    if (!sub) return null;
    sub.alerts = { ...sub.alerts, ...(alerts || {}) };
    this.save(st);
    return sub;
  }

  drop(token) {
    const st = this.state();
    delete st.subs[this.keyOf(token)];
    this.save(st);
  }

  json(token, sub) {
    return {
      id: this.keyOf(token), endpoint: sub.endpoint,
      alerts: sub.alerts || {}, policy: 'all',
      server_key: this.publicKey(),
    };
  }

  // Push one notification to every subscription whose alerts allow the type.
  // A push service answering 404/410 means the browser dropped the
  // subscription — it is removed rather than retried forever.
  async notify(n, payload) {
    const st = this.state();
    const entries = Object.entries(st.subs);
    if (!entries.length) return;
    const { publicKey, privateKey } = this.vapid();
    const details = { subject: this.subject(), publicKey, privateKey };
    let dropped = false;
    for (const [key, sub] of entries) {
      if (sub.alerts && sub.alerts[n.type] === false) continue;
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload),
          { vapidDetails: details, contentEncoding: 'aes128gcm', TTL: 3600 },
        );
      } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          delete st.subs[key];
          dropped = true;
        } else {
          this.log(`webpush: ${e?.statusCode || ''} ${e?.message || e}`);
        }
      }
    }
    if (dropped) this.save(st);
  }
}
