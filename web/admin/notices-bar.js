// notices-bar.js — the notices bell in the bar, on every page of ours.
//
// Whoever runs the site writes notices (the /notices page, admin only); every
// signed-in account sees the bell. This asks /api/notices once per page load,
// hides the bell where the site has none to offer (a DeviceAgent's own pages
// answer no such thing), lists the titles, and opens one notice at a time.
// Which notices this browser has already opened is this browser's business
// alone, so it lives in localStorage and nowhere else.
//
// Every element here is declared in the page's markup; this fills them.
(() => {
  const bell = document.getElementById('bar-notices');
  const list = document.getElementById('notices-list');
  const view = document.getElementById('notice-view');
  if (!bell || !list || !view) return;
  const $ = (id) => document.getElementById(id);
  const SEEN = 'fedipod-notices-seen';
  const readSeen = () => { try { return JSON.parse(localStorage.getItem(SEEN) || '[]'); } catch { return []; } };
  const writeSeen = (ids) => { try { localStorage.setItem(SEEN, JSON.stringify(ids.slice(-200))); } catch { /* keeps no site data */ } };

  const when = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch { return ''; } };

  // A notice's body is plain text: paragraphs at blank lines, and a bare
  // https link becomes a link. Nothing in it is ever read as markup.
  const renderBody = (el, text) => {
    el.textContent = '';
    for (const para of String(text || '').split(/\n\s*\n/u)) {
      const p = document.createElement('p');
      for (const part of para.split(/(https?:\/\/[^\s<>"']+)/u)) {
        if (/^https?:\/\//u.test(part)) {
          const a = document.createElement('a');
          a.href = part; a.textContent = part; a.target = '_blank'; a.rel = 'noopener';
          p.append(a);
        } else p.append(part);
      }
      el.append(p);
    }
  };

  let notices = [];
  const render = () => {
    const seen = new Set(readSeen());
    const fresh = notices.filter((n) => !seen.has(n.id)).length;
    $('bar-notices-count').textContent = fresh ? String(fresh) : '';
    bell.dataset.new = String(fresh);
    bell.setAttribute('aria-label', fresh ? `Notices, ${fresh} new` : 'Notices');
    const ul = $('notices-items');
    ul.textContent = '';
    if (!notices.length) {
      const p = document.createElement('p'); p.className = 'none'; p.textContent = 'No notices.';
      ul.append(p);
      return;
    }
    for (const n of notices) {
      const li = document.createElement('li');
      if (!seen.has(n.id)) li.classList.add('new');
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'notice-open'; b.textContent = n.title;
      b.addEventListener('click', () => open(n));
      const w = document.createElement('span'); w.className = 'when'; w.textContent = when(n.at);
      li.append(b, w);
      ul.append(li);
    }
  };

  const open = (n) => {
    $('notice-view-title').textContent = n.title;
    $('notice-view-when').textContent = when(n.at);
    renderBody($('notice-view-body'), n.body);
    const seen = readSeen();
    if (!seen.includes(n.id)) { seen.push(n.id); writeSeen(seen); }
    render();
    list.close();
    view.showModal();
  };

  bell.addEventListener('click', () => { render(); list.showModal(); });
  $('notices-close').addEventListener('click', () => list.close());
  $('notice-view-close').addEventListener('click', () => { view.close(); list.showModal(); });

  fetch(location.origin + '/api/notices', { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j || !Array.isArray(j.notices)) return;
      notices = j.notices;
      render();
      bell.hidden = false;
    })
    .catch(() => { /* no site notices here; the bell stays hidden */ });
})();
