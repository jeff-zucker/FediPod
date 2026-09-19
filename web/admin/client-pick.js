// client-pick.js — which fediverse client this browser opens.
//
// The site carries more than one client. Each one has its own shell page whose
// markup declares the app it frames, and every switch is an ordinary link from
// one shell to another. This file adds one thing only: it REMEMBERS which shell
// you last chose, so /admin/client/ — where signing in lands, and where the
// record's "visit account" goes — hands you back the same client next time.
//
// The choice is this browser's, not the account's. It decides which page you
// are given and nothing else: both clients talk to the same agent, with the
// same bearer, on this same origin. Nothing about the identity moves with it,
// which is why it lives in localStorage and is never written to the pod.
//
// Staged into the site by scripts/stage-site.mjs, which also generates the
// shells and the links in the bar. The device agent carries one client and
// never loads this.

const KEY = 'fedipod-client';
// The default client's shell. It is also the page that redirects, so a browser
// that has chosen something else does not have to pass through the default.
const DEFAULT_SHELL = '/admin/client/';
// A stored value is a path this site generated, and nothing else is followed.
// Without this, anything that can write localStorage — including the framed
// client itself — could send the next visit off this origin.
const SHELL = /^\/admin\/client(-[a-z0-9-]+)?\/$/;

const read = () => {
  // A private window, or a browser told to keep no site data, throws on the
  // read rather than answering empty. There is no choice to honour then, which
  // is the same as not having made one.
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
};

// Before anything renders: if this browser last chose another client, that is
// the page it asked for. `replace` and not `href`, so Back does not bounce
// between the two shells.
if (location.pathname === DEFAULT_SHELL) {
  const chosen = read();
  if (chosen && chosen !== DEFAULT_SHELL && SHELL.test(chosen)) location.replace(chosen);
}

// Somebody who knew this page when it had one client should be told, once,
// that it now has two and where to change it. Marked as said as soon as it is
// shown rather than when it is dismissed: a reader who closes the tab instead
// of pressing the button has still read it, and being told twice is worse than
// not being told a second time.
const SAID = 'fedipod-client-news';
function sayOnce() {
  const dlg = document.getElementById('client-news');
  if (!dlg) return;
  let told = true;
  try { told = !!localStorage.getItem(SAID); } catch { /* keeps no site data */ }
  if (told) return;
  try { localStorage.setItem(SAID, '1'); } catch { /* keeps no site data */ }
  dlg.showModal();
  document.getElementById('client-news-ok')?.addEventListener('click', () => dlg.close());
}

document.addEventListener('DOMContentLoaded', () => {
  sayOnce();
  // Which one is current. On a shell it is the page you are on — you may have
  // typed its address, and what is in front of you is the true answer whatever
  // storage says. Anywhere else (the record page) it is the remembered choice.
  const here = SHELL.test(location.pathname) ? location.pathname : (read() || DEFAULT_SHELL);

  for (const a of document.querySelectorAll('a.client-switch')) {
    // `aria-current` and not a class alone: this is one of a set of links, one
    // of which is the one in use — which is the state the attribute exists to
    // carry, and the only way a screen reader is told about it at all.
    if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'true');
    // Each link records the choice it stands for and then follows its own href,
    // the destination written in the markup. Recorded on the way OUT rather
    // than on arrival, so a shell opened deliberately by address — or the one
    // the redirect above lands on — does not silently become the default.
    a.addEventListener('click', () => {
      try { localStorage.setItem(KEY, a.getAttribute('href')); } catch { /* keeps no site data */ }
    });
  }
});
