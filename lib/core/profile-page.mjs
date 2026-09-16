// profile-page.mjs — the human page a browser opens for an actor: who the
// account is, its fields, when it joined, what it pinned, and a remote-follow
// control. The actor document is for servers; this is the address you hand
// to a person. The agent writes it beside the actor (publisher
// publishProfilePage) only when its content changed.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

// `fields` are the profile's name/value rows, `joined` an ISO date, `pinned`
// the pinned posts as { content (sanitized HTML), published, url }.
export function profilePageHtml({ name, address, summary = null, icon = null, image = null,
  fields = [], joined = null, pinned = [], kind = 'person' }) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ ...HTML_ESCAPES, '"': '&quot;' }[c]));
  const what = kind === 'group' ? 'a group' : 'an account';
  const month = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null
      : d.toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  };
  const day = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  };
  const fieldRows = fields.filter(f => f?.name && f?.value !== undefined && f?.value !== null && String(f.value) !== '');
  const joinedText = joined ? month(joined) : null;
  const pins = pinned.filter(x => x && typeof x.content === 'string');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} (${esc(address)})</title>
<style>
:root { color-scheme: light dark; }
body { font: 112.5%/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
img.header { width: 100%; max-height: 12rem; object-fit: cover; border-radius: 1rem; }
img.avatar { width: 6rem; height: 6rem; border-radius: 1rem; object-fit: cover; margin-top: 1rem; }
h1 { margin: .5rem 0 0; }
.address { font-size: 1.1rem; user-select: all; }
dl.fields { display: grid; grid-template-columns: max-content 1fr; gap: .4rem 1rem; margin: 1.5rem 0; }
dl.fields dt { font-weight: 600; }
dl.fields dd { margin: 0; overflow-wrap: anywhere; }
.joined { margin: 1rem 0; }
section.pinned h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
article.pin { border: 1px solid #8884; border-radius: 1rem; padding: 1rem 1.2rem; margin: 1rem 0; }
article.pin p:last-child { margin-bottom: 0; }
article.pin .when { font-size: 1rem; }
form { margin-top: 2rem; }
label { display: block; margin-bottom: .3rem; }
input { font: inherit; padding: .5rem; width: 14rem; max-width: 100%; }
button { font: inherit; padding: .5rem 1rem; }
.hint { color: #666; font-size: 1rem; }
.err { color: #b00020; }
.err:empty { display: none; }
@media (prefers-color-scheme: dark) {
  .hint { color: #aaa; }
  .err { color: #ff8a80; }
}
</style>
</head>
<body>
<main>
${image ? `<img class="header" src="${esc(image)}" alt="">` : ''}
${icon ? `<img class="avatar" src="${esc(icon)}" alt="">` : ''}
<h1>${esc(name)}</h1>
<p class="address">${esc(address)}</p>
${summary ? `<div>${summary}</div>` : ''}
${fieldRows.length ? `<dl class="fields">
${fieldRows.map(f => `<dt>${esc(f.name)}</dt><dd>${esc(f.value)}</dd>`).join('\n')}
</dl>` : ''}
${joinedText ? `<p class="joined">Joined ${esc(joinedText)}</p>` : ''}
${pins.length ? `<section class="pinned">
<h2>Pinned</h2>
${pins.map(x => `<article class="pin">
${x.content}
<p class="when">${x.url ? `<a href="${esc(x.url)}">${esc(day(x.published))}</a>` : esc(day(x.published))}</p>
</article>`).join('\n')}
</section>` : ''}
<p>This is ${what} on the Fediverse. To follow it, paste the address above
into the search box of Mastodon or any Fediverse app — or use the form.</p>
<form id="follow">
  <label for="server">your server</label>
  <input id="server" type="text" placeholder="mastodon.social" autocomplete="off"
    required aria-describedby="follow-err">
  <button type="submit">Follow</button>
  <p class="err" id="follow-err" role="alert"></p>
</form>
<p class="hint">The form sends you to your own server's follow screen.</p>
</main>
<script>
document.getElementById('follow').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const s = document.getElementById('server').value.trim().replace(/^https?:\\/\\//, '').replace(/\\/.*$/, '');
  const err = document.getElementById('follow-err');
  const addr = document.querySelector('.address').textContent.trim();
  if (!s) { err.textContent = 'Enter your server, e.g. mastodon.social'; return; }
  err.textContent = '';
  location.href = 'https://' + s + '/authorize_interaction?uri=' + encodeURIComponent(addr);
});
</script>
</body>
</html>
`;
}
