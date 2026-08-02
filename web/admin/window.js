// window.js — the floating panel, shared by every page of ours.
//
// It replaces the accordions. Those opened at the foot of the page and pushed
// whatever you were reading out from under you; worse, only one could be open,
// so looking at the log meant closing the form you were filling in. A window
// floats over the page instead, and you can move it off whatever it covers.
//
// Resizing is the browser's own grip (`resize: both`), so there is no drag
// maths here beyond moving it. Nothing is created in script: every panel is
// declared in the page's markup inside #win-body, and this only shows one.

(() => {
  const win = document.getElementById('win');
  if (!win) return;
  const bar = document.getElementById('win-bar');
  const title = document.getElementById('win-title');
  const body = document.getElementById('win-body');

  // Every direct child of the body is a panel; showing one hides the rest.
  const panels = () => [...body.children];
  let open = null;
  // Where focus was when the window opened, so closing can put it back. Without
  // this, Escape from inside the panel drops focus on <body> and the tab order
  // restarts from the top of the page.
  let returnTo = null;

  // It IS a dialog, so it says so — and a dialog that opens without taking
  // focus leaves a keyboard user tabbing forward through the rest of the page
  // to find it, and a screen-reader user with no announcement that anything
  // happened at all. It also sits over the control that opened it, so moving
  // focus in is what stops that control being focused-but-obscured.
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-modal', 'false');       // the page behind stays usable
  win.setAttribute('aria-labelledby', 'win-title');

  const focusFirst = () => {
    const panel = panels().find(p => !p.hidden);
    const target = panel?.querySelector(
      'input:not([type=hidden]), select, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
    );
    (target || document.getElementById('win-close'))?.focus();
  };

  const close = () => {
    win.hidden = true;
    for (const p of panels()) p.hidden = true;
    const was = open;
    open = null;
    // Only if focus is still ours to move: the user may have clicked away.
    const back = returnTo;
    returnTo = null;
    if (back && document.contains(back) && win.contains(document.activeElement)) back.focus();
    else if (back && document.contains(back) && document.activeElement === document.body) back.focus();
    win.dispatchEvent(new CustomEvent('win:closed', { detail: { was } }));
  };

  // Returns false when it CLOSED an already-open panel, so a button can toggle
  // itself without every caller repeating the check.
  const show = (id, label) => {
    if (open === id && !win.hidden) { close(); return false; }
    const opener = document.activeElement;
    for (const p of panels()) p.hidden = p.id !== id;
    title.textContent = label || '';
    win.hidden = false;
    open = id;
    clampIntoView();
    if (opener && opener !== document.body && !win.contains(opener)) returnTo = opener;
    focusFirst();
    return true;
  };

  // A window remembers where it was left, so it does not jump back to the
  // middle every time — but only within the page, because a position saved on a
  // wide screen is off-screen on a narrow one and there is nothing to grab.
  let placed = false;
  function clampIntoView() {
    if (!placed) return;
    const r = win.getBoundingClientRect();
    const x = Math.min(Math.max(r.left, 0), Math.max(0, innerWidth - r.width));
    const y = Math.min(Math.max(r.top, 0), Math.max(0, innerHeight - r.height));
    moveTo(x, y);
  }
  function moveTo(x, y) {
    win.style.transform = 'none';          // the centring transform, undone once moved
    win.style.left = `${x}px`;
    win.style.top = `${y}px`;
    placed = true;
  }

  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;             // the close button is not a handle
    const r = win.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    bar.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = win.getBoundingClientRect();
    moveTo(Math.min(Math.max(e.clientX - drag.dx, 0), Math.max(0, innerWidth - r.width)),
      Math.min(Math.max(e.clientY - drag.dy, 0), Math.max(0, innerHeight - r.height)));
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    try { bar.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    document.body.classList.remove('dragging');
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
  addEventListener('resize', clampIntoView);

  document.getElementById('win-close').addEventListener('click', close);
  // Escape closes it, which is what every floating thing does and what people
  // try first when a window is covering the thing they wanted to read.
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !win.hidden) close(); });

  // The whole API: open a declared panel by id, close, and ask what is open.
  window.solWindow = { show, close, openId: () => (win.hidden ? null : open) };
})();
