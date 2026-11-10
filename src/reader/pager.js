// Reading by pages: the content is a horizontal strip of pages behind a fixed frame, and a page turn
// moves the strip by one page. A turn is drawn one of four ways — a book page turning over its spine,
// a card sliding over a stack, a fade (these three with the browser's view transitions, which take a
// picture of the page before and after), or a slide of the strip itself, which also follows the
// finger. Turning: a swipe, a tap near the left or right edge, the wheel, or next()/prev().
//
// A long book is laid out a part at a time (view.js): at the last page of a part the next turn
// asks the owner to put the next part in place (canCross / cross) and lands on its first page.

const DURATION = { slide: 380, leaf: 480 };
const VIEW_TURNS = new Set(['flip', 'stack', 'fade']);
const hasViewTransitions = () => typeof document.startViewTransition === 'function';

// The page turn that follows the finger ("leaf"), drawn the way a paper page turns: a copy of the
// page lies over the book, and its corner (the lower one, or the upper one when the finger took the
// page high) is lifted and carried over to the spine on the left. The page folds along the line
// half way between where the corner was and where it is now: on the spine's side of the fold the page
// still lies flat, past it the next page shows, and the folded-over part (the back of the page,
// plain paper) lies over the rest with its shadow. The corner rises a little on its way, as paper
// does, and the finger's way up or down tilts the fold. The finger's way across the page is how far
// it has turned; let go far enough (or with a flick) and it goes over, else it falls back. A tap or a
// key turns it the whole way by itself.
const motionWanted = () => document.documentElement.dataset.motion !== 'off';
/** How long turns take against their designed length, set by the reader (library.js: --rd-turn-k). */
const turnK = () => Number(document.documentElement.style.getPropertyValue('--rd-turn-k')) || 1;

/** A CSS cubic-bezier as a function of time 0..1 → progress 0..1. */
function bezier(x1, y1, x2, y2) {
  const at = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}
const EASE_PAGE = bezier(0.22, 1, 0.36, 1);
const EASE_OUT = bezier(0.2, 0.8, 0.2, 1);

/**
 * host: the element the reader looks through; strip: what moves; frameFor(i): the element that is
 * page i on screen (pictured by the view transition); layout(): lays the pages out and returns
 * { step, count } — how far one page is and how many there are; onTurn(i) after every turn;
 * canCross(dir) / cross(dir): whether there is another part that way, and putting it in place.
 */
export function createPager({ host, strip, frameFor, layout, onTurn, canCross = () => false, cross }) {
  let index = 0;
  let target = 0; // where the latest turn is going: quick turns add up even before a page has landed
  let step = 0;
  let count = 1;
  let turn = 'flip';
  let crossing = false; // a part is being changed: further turns wait for it
  let generation = 0; // the latest turn; an older one finishing late must not undo its marks
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;

  /**
   * The turn that will really be drawn: no motion when the system asks for none, a slide where view
   * transitions are missing. A slide cannot carry on into another part: that turn fades instead.
   */
  function effective(intoAnotherPart = false) {
    if (reduced.matches || !motionWanted()) return 'none';
    if (turn === 'flip' && !intoAnotherPart && leafable()) return 'flip';
    if (VIEW_TURNS.has(turn) && !hasViewTransitions()) return 'slide';
    if (intoAnotherPart && turn === 'slide') return hasViewTransitions() ? 'fade' : 'none';
    return turn;
  }

  function place(offset = 0, at = index) {
    strip.style.transform = `translate3d(${-at * step + offset}px, 0, 0)`;
  }

  // ---------- the leaf: a page turned by hand (see the top of this file) ----------

  let leaf = null; // the leaf (makeLeaf) while a page is turned
  // A leaf made ahead, in a quiet moment after a turn: copying a part of a book and laying it out takes
  // a while on a phone, and done at the touch it made the first frames of a turn stutter. It waits
  // laid out but unseen; a change to the book (a mark, another part) makes it stale.
  let spare = null;
  let spareStale = true;
  let spareTimer = 0;
  const watcher = new MutationObserver(() => {
    spareStale = true;
  });
  watcher.observe(strip, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] });

  /** A PDF's pages are pictures a copy would not carry: those turn the other ways. */
  const leafable = () => motionWanted() && !strip.querySelector('canvas');

  /** A leaf with a copy of the book in it, laid out under the page but unseen. */
  function makeLeaf() {
    const frame = frameFor(index);
    const copy = strip.cloneNode(true);
    copy.removeAttribute('id');
    for (const el of copy.querySelectorAll('[id]')) el.removeAttribute('id');
    copy.style.transition = 'none';
    copy.setAttribute('aria-hidden', 'true');
    copy.inert = true;
    const tone = getComputedStyle(frame).backgroundColor;
    const paper = tone && tone !== 'rgba(0, 0, 0, 0)' ? tone : getComputedStyle(host).backgroundColor;
    const div = (cls, ...kids) => {
      const el = document.createElement('div');
      el.className = cls;
      el.append(...kids);
      return el;
    };
    // the page as it still lies: a copy of the book, cut off at the fold by the box around it
    const front = div('rd-leaf-front', copy);
    front.style.backgroundColor = paper;
    const crease = div('rd-leaf-crease');
    const keep = div('rd-leaf-box', front, crease);
    // the folded-over part: the back of the page, mirrored over the fold, in a box of its own
    const back = div('rd-leaf-back');
    back.style.backgroundColor = paper;
    const gloss = div('rd-leaf-gloss');
    const flap = div('rd-leaf-box rd-leaf-flap', back, gloss);
    // the lifted page's shadow on the page under it, just past the fold
    const under = div('rd-leaf-under');
    const node = div('rd-leaf spare', under, keep, flap);
    node.setAttribute('aria-hidden', 'true');
    frame.append(node);
    return { node, keep, front, copy, crease, flap, back, gloss, under, W: 0, H: 0, S: 0, corner: 'bottom', p: 0, drift: 0, raf: 0, settle: null };
  }

  /** Makes the next spare leaf when the reader is idle. */
  function prepareSpare() {
    clearTimeout(spareTimer);
    spareTimer = setTimeout(() => {
      if (leaf || !leafable() || (spare && !spareStale)) return;
      const make = () => {
        if (leaf || (spare && !spareStale)) return;
        spare?.node.remove();
        spare = makeLeaf();
        spareStale = false;
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(make, { timeout: 1200 });
      else make();
    }, 250);
  }

  /** A copy of page `at` over the book, ready to turn by its `corner` ('bottom' or 'top'): the spare one if it is still good. */
  function buildLeaf(at, corner = 'bottom') {
    let l;
    if (spare && !spareStale && spare.node.isConnected) {
      l = spare;
      spare = null;
    } else {
      spare?.node.remove();
      spare = null;
      l = makeLeaf();
    }
    spareStale = true; // the one in use is gone: another is made after this turn
    l.copy.style.transform = `translate3d(${-at * step}px, 0, 0)`;
    const box = l.node.parentElement;
    l.W = box?.clientWidth || host.clientWidth || 1;
    l.H = box?.clientHeight || host.clientHeight || 1;
    // the boxes that cut the page at the fold: big enough to hold the page however the fold lies
    l.S = Math.ceil(2 * Math.hypot(l.W, l.H)) + 4;
    for (const el of [l.keep, l.flap]) {
      el.style.width = `${l.S}px`;
      el.style.height = `${l.S}px`;
    }
    for (const el of [l.front, l.back]) {
      el.style.width = `${l.W}px`;
      el.style.height = `${l.H}px`;
    }
    l.under.style.height = `${l.S}px`;
    l.corner = corner;
    l.drift = 0;
    l.node.classList.remove('spare');
    return l;
  }

  /**
   * The leaf turned to `p`: 0 lies flat over the book, 1 has gone over to the spine. `drift` moves
   * the corner up or down (the finger's way). Each frame touches only transforms and opacities of a
   * few layers: nothing in the copied book is styled or laid out again, so a turn keeps up with the
   * screen (120-144 Hz too).
   */
  function setLeaf(l, p, drift = l.drift) {
    l.p = p;
    l.drift = drift;
    const { W, H, S } = l;
    const cy = l.corner === 'top' ? 0 : H; // the corner's edge of the page
    const inward = cy === 0 ? 1 : -1; // toward the middle of the page
    const arc = Math.sin(Math.PI * p);
    // where the corner is: carried over toward the spine, rising a little on the way
    let x = W - 2 * W * p;
    let y = cy + inward * H * 0.12 * arc + drift * arc;
    // paper does not stretch: the corner stays within a page's width of the spine at its edge...
    const reach = Math.hypot(x, y - cy);
    if (reach > W) {
      x *= W / reach;
      y = cy + ((y - cy) * W) / reach;
    }
    // ...and within the page's diagonal of the spine's other end
    const diag = Math.hypot(W, H);
    const far = Math.hypot(x, y - (H - cy));
    if (far > diag) {
      x *= diag / far;
      y = H - cy + ((y - (H - cy)) * diag) / far;
    }
    let vx = W - x;
    let vy = cy - y;
    let len = Math.hypot(vx, vy);
    // the fold: through the middle of the corner's way, across it
    let mx = (W + x) / 2;
    let my = (cy + y) / 2;
    if (len < 0.5) {
      // not lifted yet: the fold lies past the page's edge
      vx = 1;
      vy = 0;
      len = 0;
      mx = W + 1;
      my = cy;
    }
    const turn = (Math.atan2(vy, vx) * 180) / Math.PI;
    const at = `translate3d(${mx.toFixed(2)}px, ${my.toFixed(2)}px, 0) rotate(${turn.toFixed(3)}deg)`;
    const back = `rotate(${(-turn).toFixed(3)}deg) translate3d(${(-mx).toFixed(2)}px, ${(-my).toFixed(2)}px, 0)`;
    const box = `${at} translate3d(${-S}px, ${-S / 2}px, 0)`;
    l.keep.style.transform = box;
    l.flap.style.transform = box;
    l.front.style.transform = `translate3d(${S}px, ${S / 2}px, 0) ${back}`;
    l.back.style.transform = `translate3d(${S}px, ${S / 2}px, 0) scaleX(-1) ${back}`;
    // shading: how deep the folded part is decides how wide its light and shadows are
    const depth = len / 2;
    const shown = Math.min(1, depth / 12);
    const strength = Math.sqrt(Math.max(0, arc)) * shown;
    const grade = (n) => Math.max(0.001, n / 100).toFixed(4);
    l.gloss.style.transform = `scaleX(${grade(depth)})`;
    l.gloss.style.opacity = shown.toFixed(3);
    l.crease.style.transform = `scaleX(${grade(Math.min(depth, W * 0.3) * 0.6)})`;
    l.crease.style.opacity = strength.toFixed(3);
    l.under.style.transform = `${at} translate3d(0, ${-S / 2}px, 0) scaleX(${grade(8 + Math.min(depth * 0.5, W * 0.22))})`;
    l.under.style.opacity = strength.toFixed(3);
  }

  /** Turns the leaf to `to` over `ms` (the corner's drift settles too), then runs done(). */
  function animateLeaf(l, to, ms, ease, done) {
    cancelAnimationFrame(l.raf);
    const from = l.p;
    const drift = l.drift;
    const start = performance.now();
    l.settle = () => {
      cancelAnimationFrame(l.raf);
      setLeaf(l, to, 0);
      l.settle = null;
      done();
    };
    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const e = ease(t);
      setLeaf(l, from + (to - from) * e, drift * (1 - e));
      if (t < 1) l.raf = requestAnimationFrame(tick);
      else l.settle?.();
    };
    l.raf = requestAnimationFrame(tick);
  }

  /** A turn still under way ends at once where it was going (a quick next turn, a new layout). */
  function finishLeaf() {
    if (!leaf) return;
    const l = leaf;
    if (l.settle) l.settle();
    else dropLeaf(l);
  }

  function dropLeaf(l) {
    cancelAnimationFrame(l.raf);
    l.node.remove();
    if (leaf === l) leaf = null;
    prepareSpare();
  }

  /**
   * A whole turn by itself (a tap, a key): to the next page the leaf is this page going over, the
   * next one already under it; back, the leaf is the page before coming in over this one.
   */
  function leafTurn(to) {
    finishLeaf();
    const from = index;
    if (to > from) {
      const l = (leaf = buildLeaf(from));
      setLeaf(l, 0, 0);
      index = to;
      target = to;
      strip.style.transition = 'none';
      place();
      animateLeaf(l, 1, DURATION.leaf * turnK(), EASE_PAGE, () => {
        dropLeaf(l);
        onTurn?.(index);
      });
    } else {
      const l = (leaf = buildLeaf(to));
      setLeaf(l, 1, 0);
      target = to;
      animateLeaf(l, 0, DURATION.leaf * turnK(), EASE_PAGE, () => {
        index = to;
        strip.style.transition = 'none';
        place();
        dropLeaf(l);
        onTurn?.(index);
      });
    }
  }

  function relayout() {
    finishLeaf();
    ({ step, count } = layout());
    prepareSpare();
    index = Math.max(0, Math.min(index, count - 1));
    target = index;
    strip.style.transition = 'none';
    place();
  }

  async function go(page, { animate = true } = {}) {
    if (crossing) return;
    finishLeaf();
    const dir = page > count - 1 && canCross(1) ? 1 : page < 0 && canCross(-1) ? -1 : 0;
    const to = dir ? null : Math.max(0, Math.min(count - 1, page));
    if (!dir) target = to;
    if (!dir && to === index) {
      strip.style.transition = `transform 200ms ease-out`;
      place(); // back into place after a drag that did not go far enough
      return;
    }
    const from = index;
    const kind = animate ? effective(Boolean(dir)) : 'none';
    const mine = ++generation;
    // into another part: put it in place, then stand on its first page (or its last, going back)
    const land = () => {
      if (dir) {
        cross(dir);
        ({ step, count } = layout());
        index = dir > 0 ? 0 : count - 1;
        crossing = false;
      } else index = to;
      target = index;
    };
    if (kind === 'flip' && !dir && Math.abs(to - from) === 1 && leafable()) {
      leafTurn(to);
      return;
    }
    if (dir) crossing = true;
    if (kind === 'none') {
      land();
      strip.style.transition = 'none';
      place();
    } else if (kind === 'slide') {
      land();
      strip.style.transition = `transform ${Math.round(DURATION.slide * turnK())}ms cubic-bezier(.22, .7, .2, 1)`;
      place();
    } else {
      root.dataset.turn = kind;
      root.dataset.turnDir = (dir || to - from) > 0 ? 'next' : 'prev';
      const before = frameFor(from);
      before.style.viewTransitionName = 'rd-page';
      const transition = document.startViewTransition(() => {
        before.style.viewTransitionName = '';
        land();
        strip.style.transition = 'none';
        place();
        frameFor(index).style.viewTransitionName = 'rd-page';
      });
      // a quicker next turn skips this one, which then rejects "ready": that is expected
      transition.ready.catch(() => {});
      transition.finished
        .catch(() => {})
        .finally(() => {
          frameFor(index).style.viewTransitionName = '';
          if (mine === generation) {
            delete root.dataset.turn;
            delete root.dataset.turnDir;
          }
        });
      await transition.updateCallbackDone.catch(() => {
        // the update never ran (skipped before it could): do it now, so the part does not stay half-changed
        if (crossing) {
          land();
          place();
        }
      });
    }
    onTurn?.(index);
  }

  // ---------- fingers, taps, the wheel ----------

  let gesture = null;
  const LONG_PRESS = 350; // ms: a swipe moves sooner than this; a press to select waits longer
  const selecting = () => {
    const sel = document.getSelection();
    return Boolean(sel && !sel.isCollapsed && host.contains(sel.anchorNode));
  };

  function down(e) {
    if (e.button !== 0 || selecting()) return;
    gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now(), type: e.pointerType, dragging: false, dx: 0 };
  }

  function move(e) {
    if (!gesture || e.pointerId !== gesture.id) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if (!gesture.dragging) {
      // a mouse drag selects text; only a finger or a pen swipes
      if (gesture.type === 'mouse' || Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      // a finger that rested before moving was pressing to select (the phone's long press), not swiping:
      // its drift widens the selection instead of turning the page
      if (selecting() || performance.now() - gesture.at > LONG_PRESS) {
        gesture = null;
        return;
      }
      gesture.dragging = true;
      try {
        host.setPointerCapture(e.pointerId);
      } catch {
        // the pointer is already gone
      }
    }
    gesture.dx = dx;
    gesture.dy = dy;
    const now = performance.now();
    // the finger's speed over the last moments: a flick turns the page even when it went only a little way
    gesture.speed = gesture.lastAt ? (dx - gesture.lastX) / Math.max(1, now - gesture.lastAt) : 0;
    gesture.lastX = dx;
    gesture.lastAt = now;
    if (effective() === 'flip' && leafable()) {
      followLeaf(gesture, dx);
      return;
    }
    if (effective() === 'slide') {
      strip.style.transition = 'none';
      const atEdge = (index === 0 && dx > 0) || (index === count - 1 && dx < 0);
      place(atEdge ? dx / 3 : dx);
    }
  }

  function up(e) {
    if (!gesture || e.pointerId !== gesture.id) return;
    const g = gesture;
    gesture = null;
    if (g.dragging) {
      if (g.leaf) {
        releaseLeaf(g);
        return;
      }
      const far = Math.abs(g.dx) > Math.min(80, host.clientWidth * 0.18);
      // a quick flick turns the page even when it went only a little way — unless the finger turned back at the end
      const velocity = Math.abs(g.dx) / Math.max(1, performance.now() - g.at);
      const reversing = (g.speed ?? 0) * g.dx < 0 && Math.abs(g.speed ?? 0) > 0.3;
      const flick = velocity > 0.11 && Math.abs(g.dx) > 16 && !reversing;
      go(far || flick ? target + (g.dx < 0 ? 1 : -1) : index);
      return;
    }
    // a short tap near an edge turns the page, unless it lands on a link or text is being selected
    if (e.type !== 'pointerup' || performance.now() - g.at > 450 || Math.hypot(e.clientX - g.x, e.clientY - g.y) > 10) return;
    if (e.target.closest?.('a, button, input') || selecting()) return;
    const r = host.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (x < 0.28) go(target - 1);
    else if (x > 0.72) go(target + 1);
  }

  function cancel(e) {
    if (gesture && e.pointerId === gesture.id) {
      const g = gesture;
      gesture = null;
      if (g.leaf) {
        g.speed = 0;
        g.dx = 0;
        releaseLeaf(g, { back: true });
        return;
      }
      go(index);
    }
  }

  /**
   * The finger moves with a page in hand. Its first move says which way: to the left the page turns
   * over to the next; to the right the page before comes back over this one. At the first and last
   * page there is nothing to turn (the leaf only stirs); at the end of a part the next part comes the
   * usual way once the finger lets go.
   */
  function followLeaf(g, dx) {
    if (!g.leaf && !g.noLeaf) {
      finishLeaf();
      const way = dx < 0 ? 1 : -1;
      const there = index + way;
      if (there < 0 || there > count - 1) {
        g.noLeaf = true; // the edge of the book, or another part: let go decides
        g.way = way;
        return;
      }
      g.way = way;
      // a page taken high is turned by its upper corner, as with paper
      const r = host.getBoundingClientRect();
      const corner = g.y - r.top < r.height * 0.4 ? 'top' : 'bottom';
      g.leaf = leaf = buildLeaf(way > 0 ? index : there, corner);
      if (way > 0) {
        // the next page already lies under the one being turned
        strip.style.transition = 'none';
        place(0, there);
        setLeaf(g.leaf, 0, 0);
      } else setLeaf(g.leaf, 1, 0);
    }
    if (!g.leaf) return;
    const width = host.clientWidth || 1;
    // how far the page has turned: the finger's way across the page, back to where it started at most
    const p = Math.max(0, Math.min(1, (g.way > 0 ? -dx : dx) / (width * 0.85)));
    // the finger's way up or down lifts or lowers the corner, within a quarter of the page
    const reach = (g.leaf.H || width) * 0.25;
    const drift = Math.max(-reach, Math.min(reach, (g.dy ?? 0) * 0.8));
    setLeaf(g.leaf, g.way > 0 ? p : 1 - p, drift);
    g.progress = p;
  }

  /** The finger lets go of a page: over it goes, or back it falls. */
  function releaseLeaf(g, { back = false } = {}) {
    const l = g.leaf;
    const p = g.progress ?? 0;
    const flick = g.way > 0 ? -g.speed : g.speed; // px/ms in the turn's way
    const over = !back && (flick > 0.45 ? p > 0.04 : flick < -0.3 ? false : p > 0.35);
    const left = over ? 1 - p : p;
    const ms = Math.max(140, Math.min(480, left * 520 - Math.max(0, flick) * 60)) * turnK();
    if (g.way > 0) {
      animateLeaf(l, over ? 1 : 0, ms, EASE_OUT, () => {
        dropLeaf(l);
        if (over) {
          index += 1;
          target = index;
          onTurn?.(index);
        } else place(); // the page under goes back to where it was
      });
    } else {
      animateLeaf(l, over ? 0 : 1, ms, EASE_OUT, () => {
        if (over) {
          index -= 1;
          target = index;
          strip.style.transition = 'none';
          place();
        }
        dropLeaf(l);
        if (over) onTurn?.(index);
      });
    }
  }

  let wheelLock = 0;
  function wheel(e) {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 6) return;
    e.preventDefault();
    const now = performance.now();
    if (now < wheelLock) return;
    wheelLock = now + 420;
    go(target + (d > 0 ? 1 : -1));
  }

  host.addEventListener('pointerdown', down);
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerup', up);
  host.addEventListener('pointercancel', cancel);
  host.addEventListener('wheel', wheel, { passive: false });
  relayout();

  return {
    get index() {
      return index;
    },
    get count() {
      return count;
    },
    go,
    next: () => go(target + 1),
    prev: () => go(target - 1),
    relayout,
    setTurn(value) {
      turn = value;
    },
    destroy() {
      clearTimeout(spareTimer);
      watcher.disconnect();
      if (leaf) {
        cancelAnimationFrame(leaf.raf);
        leaf.node.remove();
        leaf = null;
      }
      spare?.node.remove();
      spare = null;
      host.removeEventListener('pointerdown', down);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
      host.removeEventListener('pointercancel', cancel);
      host.removeEventListener('wheel', wheel);
      strip.style.transform = '';
      strip.style.transition = '';
    },
  };
}
