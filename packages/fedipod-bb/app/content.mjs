import sanitize from 'sanitize-html';

export function safeBody(html) {
  return sanitize(String(html || ''), {
    allowedTags: ['p', 'br', 'a', 'span', 'em', 'strong', 'b', 'i', 'u', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'img'],
    allowedAttributes: { a: ['href', 'title', 'class'], img: ['src', 'alt', 'title'], '*': ['class', 'lang'] },
    allowedSchemes: ['http', 'https', 'mailto'], allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'textarea', 'noscript'],
    transformTags: { a: sanitize.simpleTransform('a', { rel: 'nofollow noopener noreferrer' }) },
  });
}

export const date = (value) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString().slice(0, 10) : '';
