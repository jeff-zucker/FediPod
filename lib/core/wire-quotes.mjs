// wire-quotes.mjs — the documents and activities a quote is made of on the
// wire (FEP-044f): the request to the quoted author, the authorization they
// publish, and the Accept or Reject that answers. The quote terms a note
// itself carries live in wire.mjs with the note.

import crypto from 'node:crypto';
import { AS_CTX, QUOTE_CTX, POLICY_CTX } from './wire.mjs';

// The activity and object types, and the two terms an authorization names
// its parties by — GoToSocial's, declared as Mastodon declares them.
export const QUOTE_TYPES_CTX = {
  QuoteRequest: 'https://w3id.org/fep/044f#QuoteRequest',
  QuoteAuthorization: 'https://w3id.org/fep/044f#QuoteAuthorization',
  gts: 'https://gotosocial.org/ns#',
  interactingObject: { '@id': 'gts:interactingObject', '@type': '@id' },
  interactionTarget: { '@id': 'gts:interactionTarget', '@type': '@id' },
};

// FEP-044f: asking the quoted post's author to allow the quote. The whole
// quoting note rides along as the instrument, so their server can see what
// is being asked without fetching it; `object` is their post.
export function quoteRequestActivity({ urls, note, quoted, quotedActor, serial }) {
  const { '@context': ctx, ...instrument } = note;   // eslint-disable-line no-unused-vars
  return {
    '@context': [AS_CTX, { ...QUOTE_CTX, ...POLICY_CTX, QuoteRequest: QUOTE_TYPES_CTX.QuoteRequest }],
    id: urls.actor + '#quote-request-' + serial,
    type: 'QuoteRequest',
    actor: urls.actor,
    to: [quotedActor],
    object: quoted,
    instrument,
  };
}

// The authorization a quoted author publishes (FEP-044f): a document of its
// own, at the quoted post's origin, naming the quoting post and the quoted
// one. A receiver checks the quote by fetching this and comparing both.
export function quoteAuthorizationId(noteId, instrumentId) {
  return noteId + '-quote-' + crypto.createHash('sha256').update(String(instrumentId)).digest('hex').slice(0, 16);
}

export function quoteAuthorizationDoc({ urls, id, instrument, target }) {
  return {
    '@context': [AS_CTX, QUOTE_TYPES_CTX],
    id,
    type: 'QuoteAuthorization',
    attributedTo: urls.actor,
    interactingObject: instrument,
    interactionTarget: target,
  };
}

// The answer to a QuoteRequest: Accept, carrying the authorization as its
// result, or Reject. The request is echoed by its id, type, actor, object
// and the instrument's id — enough for the asker to match it, and nothing a
// stranger wrote is repeated whole.
export function quoteAnswerActivity({ urls, type, request, result = null, to, serial }) {
  const idOf = (v) => (typeof v === 'string' ? v : v?.id);
  return {
    '@context': [AS_CTX, { QuoteRequest: QUOTE_TYPES_CTX.QuoteRequest }],
    id: urls.actor + '#' + type.toLowerCase() + '-' + serial,
    type,
    actor: urls.actor,
    to: [to],
    object: {
      id: idOf(request), type: 'QuoteRequest', actor: idOf(request?.actor),
      object: idOf(request?.object), instrument: idOf(request?.instrument),
    },
    ...(result ? { result } : {}),
  };
}
