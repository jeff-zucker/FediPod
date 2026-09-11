// instance.mjs — what the instance says about itself: the v1 and v2 instance
// documents, the limits a client reads from them, the title and blurb, the
// tag object, and the empty-collection stubs for endpoints a single-actor
// instance has nothing to say to.

import { TRANSPARENT_PNG } from './render.mjs';
import {
  MAX_OPTIONS as POLL_MAX_OPTIONS, MAX_OPTION_CHARS as POLL_MAX_OPTION_CHARS,
  MIN_SECONDS as POLL_MIN_SECONDS, MAX_SECONDS as POLL_MAX_SECONDS,
} from '../../core/polls.mjs';

const STUBS = new Map(Object.entries({
  '/api/v1/filters': [],
  '/api/v1/custom_emojis': [],
  '/api/v1/announcements': [],
  '/api/v1/instance/peers': [],
  '/api/v1/trends/tags': [], '/api/v1/trends/links': [],
  '/api/v2/suggestions': [],
  '/api/v1/preferences': {},
}));   // followed_tags is served live from the tag feed, not stubbed

export function instanceConfig() {
  return {
    statuses: { max_characters: 5000, max_media_attachments: 4, characters_reserved_per_url: 23 },
    media_attachments: {
      supported_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg'],
      image_size_limit: 10 * 1024 * 1024, video_size_limit: 40 * 1024 * 1024,
      image_matrix_limit: 16777216, video_matrix_limit: 2304000,
    },
    polls: {
      max_options: POLL_MAX_OPTIONS,
      max_characters_per_option: POLL_MAX_OPTION_CHARS,
      min_expiration: POLL_MIN_SECONDS,
      max_expiration: POLL_MAX_SECONDS,
    },
    accounts: { max_featured_tags: 0 },
  };
}

// Every agent used to report title 'solid-activitypub', so a client holding two
// of them showed two identical instances and you had to read the acct to tell
// them apart. The title is free text no client parses — make it say who.
export function instanceTitle(api) {
  const cfg = api.store.getConfig();
  return cfg?.handle ? `@${cfg.handle}@${api.host}` : 'FediPod';
}

// A Mastodon Tag object. The client reads `following` in its Followed
// Hashtags view and toggles it with the follow/unfollow endpoints. No usage
// history — a single-actor instance has no firehose stats to report.
export function tagObject(api, name, following, req) {
  const host = req?.headers?.host || api.host;
  return { name, url: `https://${host}/tags/${name}`, history: [], following: !!following };
}

export function instanceBlurb(api) {
  const kind = api.store.getConfig()?.kind === 'group' ? 'group' : 'actor';
  return `Solid pod ActivityPub ${kind}`;
}

export async function handle(api, ctx) {
  const { req, res, pathname, url, send } = ctx;   // eslint-disable-line no-unused-vars

  // --- instance (public) ---
  if (pathname === '/api/v1/instance') {
    const su = api.streamingUrl(req);
    return send(200, {
      uri: api.host, title: api.instanceTitle(), short_description: api.instanceBlurb(),
      description: api.instanceBlurb(), email: '', version: '4.2.0 (compatible; fedipod)',
      urls: su ? { streaming_api: su } : {},
      stats: { user_count: 1, status_count: api.store.countStatuses(), domain_count: 1 },
      languages: ['en'], registrations: false, approval_required: false, invites_enabled: false,
      configuration: instanceConfig(),
      contact_account: null, rules: [],
    });
  }
  if (pathname === '/api/v2/instance') {
    const su = api.streamingUrl(req);
    return send(200, {
      domain: api.host, title: api.instanceTitle(), version: '4.2.0 (compatible; fedipod)',
      source_url: 'https://github.com/jeff-zucker/FediPod', description: api.instanceBlurb(),
      usage: { users: { active_month: 1 } },
      thumbnail: { url: TRANSPARENT_PNG },
      languages: ['en'],
      // Both spellings: v2 clients read configuration.urls.streaming, older
      // ones the top-level urls.streaming_api, and some fall back blindly.
      // Omitted entirely when there is no streaming, so the client polls.
      urls: su ? { streaming_api: su } : {},
      configuration: {
        ...instanceConfig(),
        ...(su ? { urls: { streaming: su } } : {}),
        ...(api.webPush ? { vapid: { public_key: api.push.publicKey() } } : {}),
      },
      registrations: { enabled: false, approval_required: false, message: null },
      contact: { email: '', account: null }, rules: [],
    });
  }

  const stub = STUBS.get(pathname);
  if (stub !== undefined && req.method === 'GET') return send(200, stub);

  return false;
}
