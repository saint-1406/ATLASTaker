// Reading by pages: the content is a horizontal strip of pages behind a fixed frame, and a page turn
// moves the strip by one page. A turn is drawn one of four ways — a book page turning over its spine,
// a card sliding over a stack, a fade (these three with the browser's view transitions, which take a
// picture of the page before and after), or a slide of the strip itself, which also follows the
// finger. Turning: a swipe, a tap near the left or right edge, the wheel, or next()/prev().
//
// A long book is laid out a part at a time (view.js): at the last page of a part the next turn
// asks the owner to put the next part in place (canCross / cross) and lands on its first page.

const DURATION = { slide: 380 };
const VIEW_TURNS = new Set(['flip', 'stack', 'fade']);
const hasViewTransitions = () => typeof document.startViewTransition === 'function';

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
    if (reduced.matches) return 'none';
    if (VIEW_TURNS.has(turn) && !hasViewTransitions()) return 'slide';
    if (intoAnotherPart && turn === 'slide') return hasViewTransitions() ? 'fade' : 'none';
    return turn;
  }

  function place(offset = 0) {
    strip.style.transform = `translate3d(${-index * step + offset}px, 0, 0)`;
  }

  function relayout() {
    ({ step, count } = layout());
    index = Math.max(0, Math.min(index, count - 1));
    target = index;
    strip.style.transition = 'none';
    place();
  }

  async function go(page, { animate = true } = {}) {
    if (crossing) return;
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
    if (dir) crossing = true;
    if (kind === 'none') {
      land();
      strip.style.transition = 'none';
      place();
    } else if (kind === 'slide') {
      land();
      strip.style.transition = `transform ${DURATION.slide}ms cubic-bezier(.22, .7, .2, 1)`;
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
      if (selecting()) {
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
      const far = Math.abs(g.dx) > Math.min(80, host.clientWidth * 0.18);
      go(far ? target + (g.dx < 0 ? 1 : -1) : index);
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
      gesture = null;
      go(index);
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
