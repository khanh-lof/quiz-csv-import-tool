import {
  CompletionTimer,
  TargetRect,
  TargetSelector,
  UNDO_TARGET,
  applyTarget,
  hitTest,
  isComplete,
  isValidTarget,
  lineTarget,
  orderOf,
  parseTarget,
  placeTile,
  poolTarget,
  removeTileAt,
  undoLast,
} from './word-order-logic';
import type { SelectorStep } from './word-order-logic';

describe('answer line', () => {
  // Two tiles read 的, so tiles have to be told apart by position.
  const chunks = ['他', '的', '书', '的'];

  it('places tiles by index, so equal chunks stay distinct', () => {
    let line: number[] = [];
    line = placeTile(line, 3, chunks.length)!;
    line = placeTile(line, 0, chunks.length)!;
    expect(line).toEqual([3, 0]);
    expect(orderOf(line, chunks)).toEqual(['的', '他']);
    // The other 的 is a different tile and can still be placed.
    expect(placeTile(line, 1, chunks.length)).toEqual([3, 0, 1]);
  });

  it('does not place a tile twice, out of range or non-integer', () => {
    expect(placeTile([2], 2, 4)).toBeNull();
    expect(placeTile([], 4, 4)).toBeNull();
    expect(placeTile([], -1, 4)).toBeNull();
    expect(placeTile([], 1.5, 4)).toBeNull();
  });

  it('undoes the last tile and does nothing on an empty line', () => {
    expect(undoLast([2, 0, 1])).toEqual([2, 0]);
    expect(undoLast([])).toBeNull();
  });

  it('sends only the picked tile back and closes the gap', () => {
    expect(removeTileAt([2, 0, 1, 3], 1)).toEqual([2, 1, 3]);
    expect(removeTileAt([2, 0, 1, 3], 3)).toEqual([2, 0, 1]);
    expect(removeTileAt([2, 0], 2)).toBeNull();
    expect(removeTileAt([2, 0], -1)).toBeNull();
  });

  it('returns a removed tile to the pool, where it can be placed again', () => {
    const line = removeTileAt([0, 1, 2], 0)!;
    expect(line).toEqual([1, 2]);
    expect(isValidTarget(line, poolTarget(0), 3)).toBeTrue();
    expect(isValidTarget(line, poolTarget(1), 3)).toBeFalse();
  });

  it('is complete only when every tile is placed', () => {
    expect(isComplete([0, 1, 2], 4)).toBeFalse();
    expect(isComplete([0, 1, 2, 3], 4)).toBeTrue();
    expect(isComplete([], 0)).toBeFalse();
  });

  it('builds the order from the chunk texts', () => {
    expect(orderOf([2, 1, 0, 3], chunks)).toEqual(['书', '的', '他', '的']);
  });
});

describe('targets', () => {
  it('parses the three kinds and rejects the rest', () => {
    expect(parseTarget('pool:3')).toEqual({ kind: 'place', index: 3 });
    expect(parseTarget('line:0')).toEqual({ kind: 'remove', position: 0 });
    expect(parseTarget(UNDO_TARGET)).toEqual({ kind: 'undo' });
    expect(parseTarget('pool:')).toBeNull();
    expect(parseTarget('tile:1')).toBeNull();
    expect(parseTarget('pool:-1')).toBeNull();
  });

  it('applies a pick to the line', () => {
    expect(applyTarget([], poolTarget(2), 3)).toEqual([2]);
    expect(applyTarget([2], poolTarget(2), 3)).toBeNull();
    expect(applyTarget([2, 0], lineTarget(0), 3)).toEqual([0]);
    expect(applyTarget([2, 0], lineTarget(2), 3)).toBeNull();
    expect(applyTarget([2, 0], UNDO_TARGET, 3)).toEqual([2]);
    expect(applyTarget([], UNDO_TARGET, 3)).toBeNull();
    expect(applyTarget([], 'nonsense', 3)).toBeNull();
  });

  it('offers only targets that exist now', () => {
    const line = [1, 0];
    expect(isValidTarget(line, poolTarget(2), 3)).toBeTrue();
    expect(isValidTarget(line, poolTarget(0), 3)).toBeFalse();
    expect(isValidTarget(line, poolTarget(3), 3)).toBeFalse();
    expect(isValidTarget(line, lineTarget(1), 3)).toBeTrue();
    expect(isValidTarget(line, lineTarget(2), 3)).toBeFalse();
    expect(isValidTarget(line, UNDO_TARGET, 3)).toBeTrue();
    expect(isValidTarget([], UNDO_TARGET, 3)).toBeFalse();
  });
});

describe('hitTest', () => {
  const rects: TargetRect[] = [
    { id: 'a', x: 100, y: 100, width: 100, height: 80 },
    { id: 'b', x: 220, y: 100, width: 100, height: 80 },
  ];

  it('finds the target the point is inside', () => {
    expect(hitTest(150, 140, rects, 10)).toBe('a');
    expect(hitTest(270, 140, rects, 10)).toBe('b');
  });

  it('counts a point just outside a target as a hit', () => {
    expect(hitTest(95, 140, rects, 10)).toBe('a');
    expect(hitTest(150, 188, rects, 10)).toBe('a');
    expect(hitTest(150, 195, rects, 10)).toBeNull();
  });

  it('misses a point farther than the pad', () => {
    expect(hitTest(0, 0, rects, 10)).toBeNull();
    expect(hitTest(210, 300, rects, 10)).toBeNull();
  });

  it('picks the nearer target where two grown areas overlap, whatever the order', () => {
    // 205 is 5 from a's right edge (200) and 15 from b's left edge (220).
    expect(hitTest(205, 140, rects, 20)).toBe('a');
    expect(hitTest(205, 140, [...rects].reverse(), 20)).toBe('a');
    expect(hitTest(215, 140, rects, 20)).toBe('b');
  });

  it('prefers a target the point is inside over a nearer centre outside', () => {
    const big: TargetRect[] = [
      { id: 'wide', x: 0, y: 0, width: 400, height: 100 },
      { id: 'small', x: 410, y: 20, width: 20, height: 20 },
    ];
    expect(hitTest(395, 30, big, 30)).toBe('wide');
  });

  it('returns null without targets', () => {
    expect(hitTest(1, 1, [], 10)).toBeNull();
  });
});

// Drives a selector with a hover id over time, 50 ms per step like a hand frame at 20 Hz.
function run(
  selector: TargetSelector,
  hover: string | null,
  from: number,
  to: number,
  extra: { pinched?: boolean } = {},
): SelectorStep[] {
  const steps: SelectorStep[] = [];
  for (let now = from; now <= to; now += 50) {
    steps.push(selector.step({ hover, now, ...extra }));
  }
  return steps;
}

function picks(steps: SelectorStep[]): string[] {
  return steps.filter(step => step.picked !== null).map(step => step.picked!);
}

describe('TargetSelector dwell', () => {
  it('fills the ring and picks after the dwell time', () => {
    const selector = new TargetSelector();
    const steps = run(selector, 'pool:0', 0, 650);
    expect(steps.every(step => step.picked === null)).toBeTrue();
    expect(steps[0].started).toBeTrue();
    expect(steps[0].target).toBe('pool:0');
    expect(steps[7].progress).toBeCloseTo(350 / 700);
    expect(steps[13].progress).toBeCloseTo(650 / 700);

    const last = selector.step({ hover: 'pool:0', now: 700 });
    expect(last.picked).toBe('pool:0');
    expect(last.via).toBe('dwell');
    expect(last.target).toBeNull();
  });

  it('reports the start and the half once each', () => {
    const selector = new TargetSelector();
    const steps = run(selector, 'pool:0', 0, 650);
    expect(steps.filter(step => step.started).length).toBe(1);
    expect(steps.filter(step => step.halfway).length).toBe(1);
    expect(steps.findIndex(step => step.halfway)).toBe(7);
  });

  it('resets the ring when the cursor leaves the target', () => {
    const selector = new TargetSelector();
    run(selector, 'pool:0', 0, 500);
    // Away for longer than the grace.
    const away = run(selector, null, 550, 700);
    expect(away[away.length - 1].target).toBeNull();
    expect(away[away.length - 1].progress).toBe(0);
    // Coming back starts from zero, so 700 ms after 750 is needed, not 700 ms after 0.
    const back = run(selector, 'pool:0', 750, 1400);
    expect(picks(back)).toEqual([]);
    expect(back[0].started).toBeTrue();
    expect(selector.step({ hover: 'pool:0', now: 1450 }).picked).toBe('pool:0');
  });

  it('keeps the hover through a slip shorter than the grace', () => {
    const selector = new TargetSelector();
    run(selector, 'pool:0', 0, 300);
    const slip = selector.step({ hover: null, now: 350 });
    expect(slip.target).toBe('pool:0');
    const back = selector.step({ hover: 'pool:0', now: 400 });
    expect(back.started).toBeFalse();
    expect(back.progress).toBeCloseTo(400 / 700);
  });

  it('does not pick while the cursor is in the middle of a slip', () => {
    const selector = new TargetSelector();
    run(selector, 'pool:0', 0, 650);
    // The dwell would complete at 700, but the cursor is off the target on that step.
    const slip = selector.step({ hover: null, now: 700 });
    expect(slip.picked).toBeNull();
    expect(selector.step({ hover: 'pool:0', now: 750 }).picked).toBe('pool:0');
  });

  it('restarts at once on another target', () => {
    const selector = new TargetSelector();
    run(selector, 'pool:0', 0, 400);
    const move = selector.step({ hover: 'pool:1', now: 450 });
    expect(move.target).toBe('pool:1');
    expect(move.started).toBeTrue();
    expect(move.progress).toBe(0);
  });

  it('highlights a hover even while it is not dwelling', () => {
    const selector = new TargetSelector();
    run(selector, 'undo', 0, 700);
    const cooling = selector.step({ hover: 'undo', now: 750 });
    expect(cooling.hovered).toBe('undo');
    expect(cooling.target).toBeNull();
  });
});

describe('TargetSelector cooldown', () => {
  it('does not dwell on the picked target again during the cooldown', () => {
    const selector = new TargetSelector();
    run(selector, 'undo', 0, 650);
    expect(selector.step({ hover: 'undo', now: 700 }).picked).toBe('undo');
    const cooling = run(selector, 'undo', 750, 1050);
    expect(cooling.every(step => step.target === null && step.picked === null)).toBeTrue();
  });

  it('offers the target again after the cooldown, with a fresh ring', () => {
    const selector = new TargetSelector();
    run(selector, 'undo', 0, 650);
    selector.step({ hover: 'undo', now: 700 });
    run(selector, 'undo', 750, 1050);
    const again = selector.step({ hover: 'undo', now: 1100 });
    expect(again.target).toBe('undo');
    expect(again.started).toBeTrue();
    expect(again.progress).toBe(0);
  });

  it('picks a held target once per dwell plus cooldown, not continuously', () => {
    const selector = new TargetSelector();
    const steps = run(selector, 'undo', 0, 3000);
    // Picks at 700, then 700 + 400 cooldown + 700 dwell = 1800 (a step later), then 2900.
    expect(picks(steps).length).toBe(3);
    expect(steps.findIndex(step => step.picked !== null)).toBe(14);
  });

  it('lets the cursor go straight to another target during the cooldown', () => {
    const selector = new TargetSelector();
    run(selector, 'line:0', 0, 650);
    selector.step({ hover: 'line:0', now: 700 });
    const next = selector.step({ hover: 'pool:2', now: 750 });
    expect(next.target).toBe('pool:2');
    expect(next.started).toBeTrue();
  });

  it('ends the cooldown once the cursor has left the target', () => {
    const selector = new TargetSelector();
    run(selector, 'undo', 0, 650);
    selector.step({ hover: 'undo', now: 700 });
    run(selector, null, 750, 900);
    // Back on it 200 ms after the pick, well inside the 400 ms cooldown, but it was left.
    const back = selector.step({ hover: 'undo', now: 950 });
    expect(back.target).toBe('undo');
  });

  it('does not count a one-frame slip as leaving', () => {
    const selector = new TargetSelector();
    run(selector, 'undo', 0, 650);
    selector.step({ hover: 'undo', now: 700 });
    selector.step({ hover: null, now: 750 });
    const back = selector.step({ hover: 'undo', now: 800 });
    expect(back.target).toBeNull();
  });
});

describe('TargetSelector pinch', () => {
  it('picks the hovered target at once', () => {
    const selector = new TargetSelector();
    run(selector, 'pool:1', 0, 300);
    const step = selector.step({ hover: 'pool:1', pinchDown: true, pinched: true, now: 350 });
    expect(step.picked).toBe('pool:1');
    expect(step.via).toBe('pinch');
    expect(step.target).toBeNull();
  });

  it('does nothing without a target', () => {
    const selector = new TargetSelector();
    run(selector, null, 0, 300);
    const step = selector.step({ hover: null, pinchDown: true, pinched: true, now: 350 });
    expect(step.picked).toBeNull();
  });

  it('picks the target it was resting on when the fingertip drifts onto a neighbour', () => {
    const selector = new TargetSelector();
    run(selector, 'pool:1', 0, 300);
    // The cursor slips to pool:2 as the fingers close; the pinch is reported 50 ms later.
    selector.step({ hover: 'pool:2', now: 350 });
    const step = selector.step({ hover: 'pool:2', pinchDown: true, pinched: true, now: 400 });
    expect(step.picked).toBe('pool:1');
  });

  it('picks the target it was resting on when the fingertip drifts off everything', () => {
    const selector = new TargetSelector();
    run(selector, 'pool:1', 0, 300);
    selector.step({ hover: null, now: 350 });
    const step = selector.step({ hover: null, pinchDown: true, pinched: true, now: 400 });
    expect(step.picked).toBe('pool:1');
  });

  it('forgets a target left long ago', () => {
    const selector = new TargetSelector();
    run(selector, 'pool:1', 0, 300);
    run(selector, null, 350, 800);
    const step = selector.step({ hover: null, pinchDown: true, pinched: true, now: 850 });
    expect(step.picked).toBeNull();
  });

  it('picks a target the cursor has settled on, not the one it left', () => {
    const selector = new TargetSelector();
    run(selector, 'pool:1', 0, 300);
    run(selector, 'pool:2', 350, 600);
    const step = selector.step({ hover: 'pool:2', pinchDown: true, pinched: true, now: 650 });
    expect(step.picked).toBe('pool:2');
  });

  it('is not held back by the cooldown of an earlier dwell pick', () => {
    const selector = new TargetSelector();
    run(selector, 'undo', 0, 650);
    selector.step({ hover: 'undo', now: 700 });
    const step = selector.step({ hover: 'undo', pinchDown: true, pinched: true, now: 800 });
    expect(step.picked).toBe('undo');
  });

  it('does not start a dwell while the fingers are closed', () => {
    const selector = new TargetSelector();
    const steps = run(selector, 'pool:2', 0, 1500, { pinched: true });
    expect(steps.every(step => step.target === null && step.picked === null)).toBeTrue();
    // Once released the dwell begins as usual.
    expect(selector.step({ hover: 'pool:2', now: 1550 }).started).toBeTrue();
  });

  it('does not dwell on a target just picked by pinch until it is left or the cooldown ends', () => {
    const selector = new TargetSelector();
    run(selector, 'pool:1', 0, 300);
    selector.step({ hover: 'pool:1', pinchDown: true, pinched: true, now: 350 });
    const released = run(selector, 'pool:1', 400, 700);
    expect(released.every(step => step.target === null)).toBeTrue();
    expect(selector.step({ hover: 'pool:1', now: 750 }).target).toBe('pool:1');
  });
});

describe('TargetSelector reset', () => {
  it('clears the dwell, the cooldown and the pinch memory', () => {
    const selector = new TargetSelector();
    run(selector, 'undo', 0, 650);
    selector.step({ hover: 'undo', now: 700 });
    selector.reset();
    const fresh = selector.step({ hover: 'undo', now: 750 });
    expect(fresh.target).toBe('undo');
    expect(fresh.started).toBeTrue();

    selector.reset();
    run(selector, 'pool:1', 800, 1000);
    selector.step({ hover: null, now: 1050 });
    selector.reset();
    const step = selector.step({ hover: null, pinchDown: true, pinched: true, now: 1100 });
    expect(step.picked).toBeNull();
  });

  it('treats a long pause between steps as a reset, not as hover time', () => {
    const selector = new TargetSelector();
    run(selector, 'pool:0', 0, 300);
    const after = selector.step({ hover: 'pool:0', now: 5000 });
    expect(after.picked).toBeNull();
    expect(after.started).toBeTrue();
    expect(after.progress).toBe(0);
  });
});

describe('CompletionTimer', () => {
  it('reports a complete line once, after the delay', () => {
    const timer = new CompletionTimer(400);
    expect(timer.step(true, 1000)).toBeFalse();
    expect(timer.step(true, 1300)).toBeFalse();
    expect(timer.step(true, 1400)).toBeTrue();
    expect(timer.step(true, 1500)).toBeFalse();
    expect(timer.step(true, 5000)).toBeFalse();
  });

  it('starts over when a tile is taken back in the window', () => {
    const timer = new CompletionTimer(400);
    timer.step(true, 1000);
    timer.step(false, 1200);
    expect(timer.step(true, 1300)).toBeFalse();
    expect(timer.step(true, 1650)).toBeFalse();
    expect(timer.step(true, 1700)).toBeTrue();
  });

  it('never reports an incomplete line', () => {
    const timer = new CompletionTimer(400);
    expect(timer.step(false, 0)).toBeFalse();
    expect(timer.step(false, 10_000)).toBeFalse();
  });

  it('can report again after a reset, for the next question', () => {
    const timer = new CompletionTimer(400);
    timer.step(true, 0);
    expect(timer.step(true, 400)).toBeTrue();
    timer.reset();
    timer.step(true, 1000);
    expect(timer.step(true, 1400)).toBeTrue();
  });
});
