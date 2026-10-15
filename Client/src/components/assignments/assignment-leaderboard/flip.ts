// A FLIP reorder (first, last, invert, play) for the rows of the leaderboard: the page takes each row's place
// before the list changes, the list changes (the rows jump to their new places), and `playFlip` puts every
// row that moved back where it was with a transform and lets it slide to its new place. Only the transform
// moves, so the animation costs no layout.

const ROW_SELECTOR = '[data-player-id]';

// How long past the animation's end a row waits for its `transitionend` before it is cleaned up anyway (the
// event never comes for a row that was hidden or removed meanwhile).
const FALLBACK_SLACK_MS = 60;

// Each row's cleanup while it is animating, so a new animation can finish the old one first.
const running = new WeakMap<HTMLElement, () => void>();

function rowsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(ROW_SELECTOR));
}

// The place of every row ([data-player-id]) in the viewport, by player id: the "first" of FLIP. Call it
// before the list changes.
export function captureRows(container: HTMLElement): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  for (const row of rowsOf(container)) {
    rects.set(row.dataset['playerId'] ?? '', row.getBoundingClientRect());
  }
  return rects;
}

// Whether the visitor asked their system for less motion; also false where `matchMedia` does not exist.
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// The "invert" and "play" of FLIP: every row that was in `before` and is now somewhere else is moved back to
// its old place with no transition, the page is made to lay out, and then the transform goes to none over
// `durationMs`, so the row slides to its new place. A row that was not in `before` (a new student) or did not
// move stays untouched. A row cleans its inline styles up when its transition ends, or a little after it
// should have, whichever comes first. A row that is still moving from an earlier call is finished first, so
// its new place is measured without the old offset.
export function playFlip(container: HTMLElement, before: ReadonlyMap<string, DOMRect>, durationMs = 400): void {
  const rows = rowsOf(container);
  for (const row of rows) {
    running.get(row)?.();
  }

  const moving: { row: HTMLElement; shift: number }[] = [];
  for (const row of rows) {
    const old = before.get(row.dataset['playerId'] ?? '');
    if (old === undefined) {
      continue;
    }
    const shift = old.top - row.getBoundingClientRect().top;
    if (Math.abs(shift) >= 1) {
      moving.push({row, shift});
    }
  }
  if (moving.length === 0) {
    return;
  }

  for (const {row, shift} of moving) {
    row.style.transition = 'none';
    row.style.transform = `translateY(${shift}px)`;
  }
  // Forces the layout, so the transition starts from the offset and not from the final place.
  container.getBoundingClientRect();

  for (const {row} of moving) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      row.removeEventListener('transitionend', onEnd);
      row.style.transition = '';
      row.style.transform = '';
      // Clearing the styles does not stop a transition that is still running (its end value, none, is the value
      // the row has again), so a row cut short has to have it cancelled to be at its place for the next measure.
      for (const animation of row.getAnimations?.() ?? []) {
        animation.cancel();
      }
      running.delete(row);
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === row && event.propertyName === 'transform') {
        finish();
      }
    };
    row.addEventListener('transitionend', onEnd);
    timer = setTimeout(finish, durationMs + FALLBACK_SLACK_MS);
    running.set(row, finish);
    row.style.transition = `transform ${durationMs}ms ease`;
    row.style.transform = 'none';
  }
}
