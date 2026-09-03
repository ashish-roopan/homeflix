'use strict';
// TV-remote style control. Arrow keys and game controllers (Gamepad API) move a focus ring around
// whatever is on screen; buttons map to the keys the components already understand.
//
//   D-pad / left stick   move            A / Enter   open the focused card, press the focused button
//   X                    play the card   B / Esc     back (close modal, leave player, list -> home)
//   Y                    search          Start       open / play-pause
//   RB                   next episode (player)        Select/Back   home
//
// In the player the d-pad seeks and changes volume, exactly like the arrow keys.
window.UI = window.UI || {};
(function () {
  const overlay = document.getElementById('overlay');
  const FOCUSABLE = '.card, button:not(.card-play):not(.row-chevron):not([disabled]), input:not([type="range"]), .episode, a[href]';
  const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, SELECT: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
  const DIRS = { [BTN.UP]: 'up', [BTN.DOWN]: 'down', [BTN.LEFT]: 'left', [BTN.RIGHT]: 'right' };
  const KEY_DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const ARROW_OF = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  const REPEAT_FIRST_MS = 380;
  const REPEAT_MS = 110;
  const held = new Map(); // gamepad index -> Map(button -> { since, last })
  let raf = 0;

  const inPlayer = () => document.body.dataset.view === 'player' && overlay.hidden;
  const scope = () => (overlay.hidden ? document.getElementById('view') : overlay);
  const isTyping = (el) => Boolean(el && /INPUT|TEXTAREA/.test(el.tagName) && !/checkbox|radio|button|submit/.test(el.type || ''));

  function visible(el) {
    if (el.hidden || el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  }
  function candidates() {
    const seen = new Set();
    const out = [];
    for (const el of scope().querySelectorAll(FOCUSABLE)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (visible(el)) out.push(el);
    }
    return out;
  }
  const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const overlapY = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const overlapX = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left);

  /** Nearest focusable element in a direction. Left/right stay within the same row; up/down go to the
   *  nearest row and pick the element closest horizontally, the way a TV app does. */
  function pick(dir, cur) {
    const r = cur.getBoundingClientRect();
    const c = center(r);
    const horizontal = dir === 'left' || dir === 'right';
    const scored = [];
    for (const el of candidates()) {
      if (el === cur || cur.contains(el) || el.contains(cur)) continue;
      const b = el.getBoundingClientRect();
      const bc = center(b);
      if (horizontal) {
        if (dir === 'right' ? bc.x <= c.x + 1 : bc.x >= c.x - 1) continue;
        if (overlapY(r, b) < Math.min(r.height, b.height) * 0.3) continue;
        const gap = dir === 'right' ? b.left - r.right : r.left - b.right;
        scored.push({ el, gap: Math.max(0, gap) + Math.abs(bc.y - c.y) * 0.5, dx: 0 });
      } else {
        if (dir === 'down' ? bc.y <= c.y + 1 : bc.y >= c.y - 1) continue;
        const gap = dir === 'down' ? b.top - r.bottom : r.top - b.bottom;
        if (gap < -Math.min(r.height, b.height) * 0.5) continue; // beside us, not above/below
        const dx = overlapX(r, b) > 0 ? 0 : Math.min(Math.abs(b.left - c.x), Math.abs(b.right - c.x));
        scored.push({ el, gap: Math.max(0, gap), dx });
      }
    }
    if (!scored.length) {
      // Nothing in this row: moving left reaches the rail, moving right leaves it (nearest by distance).
      if (horizontal) {
        const rail = cur.closest('.sidebar');
        let best = null;
        let bestD = Infinity;
        for (const el of candidates()) {
          if (el === cur || (!rail && !el.closest('.sidebar'))) continue;
          const b = el.getBoundingClientRect();
          const bc = center(b);
          if (dir === 'right' ? bc.x <= c.x + 1 : bc.x >= c.x - 1) continue;
          const d = Math.abs(bc.x - c.x) * 0.3 + Math.abs(bc.y - c.y);
          if (d < bestD) {
            bestD = d;
            best = el;
          }
        }
        return best;
      }
      return null;
    }
    if (horizontal) return scored.sort((a, b) => a.gap - b.gap)[0].el;
    const nearest = Math.min(...scored.map((s) => s.gap));
    return scored.filter((s) => s.gap <= nearest + 40).sort((a, b) => a.dx - b.dx)[0].el;
  }

  function focusEl(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    const r = el.getBoundingClientRect();
    const offscreen = r.top < 90 || r.bottom > window.innerHeight - 16 || r.left < 0 || r.right > window.innerWidth;
    if (offscreen) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }

  function initialTarget() {
    const s = scope();
    return s.querySelector('.modal-actions .btn:not([disabled])') || s.querySelector('.hero-actions .btn:not([disabled])') || s.querySelector('.card') || candidates()[0] || null;
  }

  function move(dir) {
    const cur = document.activeElement;
    const usable = cur && cur !== document.body && scope().contains(cur) && visible(cur);
    if (!usable) return focusEl(initialTarget());
    const next = pick(dir, cur);
    if (next) return focusEl(next);
    // Rows materialise cards lazily: nudge the row so the next card exists, then look again.
    const track = cur.closest('.row-track');
    if (track && (dir === 'left' || dir === 'right')) {
      track.scrollBy({ left: dir === 'right' ? 320 : -320 });
      setTimeout(() => {
        const n = pick(dir, cur);
        if (n) focusEl(n);
      }, 160);
    }
  }

  /** Synthesise a key press where the components listen (the focused element, bubbling to document). */
  function press(key) {
    const a = document.activeElement;
    const target = a && a !== document.body ? a : document;
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }
  const back = () => press('Escape');

  function primary() {
    const a = document.activeElement;
    if (!a || a === document.body) return move('down');
    if (a.matches('.card, .episode, input')) return press('Enter'); // these handle Enter themselves
    if (a.matches('button, a')) return a.click();
  }
  function play() {
    const a = document.activeElement;
    if (a && a.matches('.card')) return press(' '); // Space on a card = play
    return primary();
  }
  function focusSearch() {
    const input = document.querySelector('.search-input');
    if (input) {
      input.focus();
      input.select();
    } else if (UI.remote.search) UI.remote.search(); // opens the field and focuses it
  }

  function activate() {
    document.body.classList.add('remote');
  }
  document.addEventListener('mousemove', () => document.body.classList.remove('remote'), { passive: true });

  // ---- keyboard ----
  document.addEventListener('keydown', (e) => {
    const dir = KEY_DIRS[e.key];
    if (!dir || e.defaultPrevented || inPlayer()) return;
    const a = document.activeElement;
    if (isTyping(a) && (dir === 'left' || dir === 'right' || a.type === 'number')) return;
    e.preventDefault();
    activate();
    move(dir);
  });

  // ---- gamepad ----
  function fire(button) {
    activate();
    const dir = DIRS[button];
    if (dir) return inPlayer() ? press(ARROW_OF[dir]) : move(dir);
    switch (button) {
      case BTN.A: return inPlayer() ? press(' ') : primary();
      case BTN.B: return back();
      case BTN.X: return inPlayer() ? press(' ') : play();
      case BTN.Y: return inPlayer() ? press('f') : focusSearch();
      case BTN.START: return inPlayer() ? press(' ') : primary();
      case BTN.RB: return inPlayer() ? press('n') : undefined;
      case BTN.SELECT: return !inPlayer() && UI.remote.home ? UI.remote.home() : undefined;
      default: return undefined;
    }
  }

  function poll(now) {
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
    if (!pads.length) {
      raf = 0;
      return;
    }
    for (const gp of pads) {
      const pressed = new Set();
      gp.buttons.forEach((b, i) => (b.pressed || b.value > 0.5) && pressed.add(i));
      const ax = gp.axes[0] || 0;
      const ay = gp.axes[1] || 0;
      if (ax < -0.55) pressed.add(BTN.LEFT);
      if (ax > 0.55) pressed.add(BTN.RIGHT);
      if (ay < -0.55) pressed.add(BTN.UP);
      if (ay > 0.55) pressed.add(BTN.DOWN);
      const h = held.get(gp.index) || new Map();
      for (const b of pressed) {
        const st = h.get(b);
        if (!st) {
          h.set(b, { since: now, last: now });
          fire(b);
        } else if (DIRS[b] && now - st.since > REPEAT_FIRST_MS && now - st.last > REPEAT_MS) {
          st.last = now;
          fire(b);
        }
      }
      for (const b of [...h.keys()]) if (!pressed.has(b)) h.delete(b);
      held.set(gp.index, h);
    }
    raf = requestAnimationFrame(poll);
  }

  window.addEventListener('gamepadconnected', (e) => {
    UI.toast(`Controller connected. D-pad moves, A opens, X plays, B goes back.`, { ms: 5000 });
    if (!raf) raf = requestAnimationFrame(poll);
    console.log('[remote] gamepad connected:', e.gamepad.id);
  });
  window.addEventListener('gamepaddisconnected', () => {
    held.clear();
    UI.toast('Controller disconnected.', { ms: 2500 });
  });
  // A pad plugged in before launch only announces itself on its first button press; start polling anyway.
  if (navigator.getGamepads && Array.from(navigator.getGamepads()).some(Boolean)) raf = requestAnimationFrame(poll);

  UI.remote = { move, back, press, home: null, search: null };
})();
