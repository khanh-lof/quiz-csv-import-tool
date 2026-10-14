import {
  BiteDetector,
  HoldGate,
  OneEuroFilter,
  PinchDetector,
  PointSmoother,
  TiltGate,
  countExtendedFingers,
  dist2d,
  eyeRoll,
  headSignal,
  mapToStage,
  mirrorX,
  pinchRatio,
  segHit,
  thumbChoice,
} from './gestures';
import type { TiltStep } from './gestures';
import type { HandFrame, Point3 } from './stage-game';

// A hand of 21 points with the landmarks the detectors read set explicitly. The wrist is at the
// bottom, the fingers point up (smaller y), like a hand held up to the camera.
function blankHand(): Point3[] {
  return Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
}

// Index, middle, ring, pinky: [tip, pip, x]. PIPs sit at y = 0.5, a quarter of the frame above the
// wrist (y = 0.9).
const FINGER_COLUMNS: ReadonlyArray<readonly [number, number, number]> = [
  [8, 6, 0.42],
  [12, 10, 0.48],
  [16, 14, 0.54],
  [20, 18, 0.6],
];

function upright(extended: boolean[]): Point3[] {
  const hand = blankHand();
  hand[0] = { x: 0.5, y: 0.9, z: 0 };
  FINGER_COLUMNS.forEach(([tip, pip, x], i) => {
    hand[pip] = { x, y: 0.5, z: 0 };
    // Extended: the tip is far above the joint. Curled: it is folded back down toward the palm.
    hand[tip] = { x, y: extended[i] ? 0.28 : 0.6, z: 0 };
  });
  return hand;
}

// A hand whose thumb and index tips are `gap` apart, with a wrist-to-knuckle size of 0.3.
function pinching(gap: number): Point3[] {
  const hand = blankHand();
  hand[0] = { x: 0.5, y: 0.9, z: 0 };
  hand[9] = { x: 0.5, y: 0.6, z: 0 };
  hand[4] = { x: 0.4, y: 0.4, z: 0 };
  hand[8] = { x: 0.4 + gap, y: 0.4, z: 0 };
  return hand;
}

describe('mapping and distances', () => {
  it('mirrors x', () => {
    expect(mirrorX(0.25)).toBeCloseTo(0.75);
    expect(mirrorX(0)).toBe(1);
  });

  it('maps a video that fits the stage exactly with only the mirroring', () => {
    const p = mapToStage(0.25, 0.5, 640, 480, 800, 600);
    expect(p.x).toBeCloseTo(600);
    expect(p.y).toBeCloseTo(300);
    const q = mapToStage(0.25, 0.5, 640, 480, 800, 600, false);
    expect(q.x).toBeCloseTo(200);
  });

  it('accounts for object-fit: cover cropping a wide video on a square stage', () => {
    // 16:9 video on a 600x600 stage: scaled to 600 tall, so 1066.7 wide, 233.3 cropped per side.
    const center = mapToStage(0.5, 0.5, 1280, 720, 600, 600);
    expect(center.x).toBeCloseTo(300);
    expect(center.y).toBeCloseTo(300);
    const unmirrored = mapToStage(0.25, 0.5, 1280, 720, 600, 600, false);
    expect(unmirrored.x).toBeCloseTo(33.33, 1);
    const mirrored = mapToStage(0.25, 0.5, 1280, 720, 600, 600);
    expect(mirrored.x).toBeCloseTo(566.67, 1);
    // The left edge of the image is cropped away, so it lands outside the stage.
    expect(mapToStage(0, 0.5, 1280, 720, 600, 600, false).x).toBeLessThan(0);
  });

  it('crops top and bottom when the video is taller than the stage', () => {
    // 3:4 portrait video on a 800x400 stage: scaled to 800 wide, 1066.7 tall.
    const p = mapToStage(0.5, 0, 600, 800, 800, 400, false);
    expect(p.x).toBeCloseTo(400);
    expect(p.y).toBeCloseTo(-333.33, 1);
  });

  it('stretches over the stage while the video has no size yet', () => {
    expect(mapToStage(0.25, 0.5, 0, 0, 800, 600)).toEqual({ x: 600, y: 300 });
  });

  it('scales x by the aspect so distances are isotropic', () => {
    const a = { x: 0, y: 0 };
    expect(dist2d(a, { x: 0.1, y: 0 })).toBeCloseTo(0.1);
    expect(dist2d(a, { x: 0.1, y: 0 }, 2)).toBeCloseTo(0.2);
    expect(dist2d(a, { x: 0.3, y: 0.4 })).toBeCloseTo(0.5);
  });
});

describe('OneEuroFilter', () => {
  it('returns the first value unchanged', () => {
    expect(new OneEuroFilter().filter(0.7, 0)).toBe(0.7);
  });

  it('smooths a step and converges to the new value', () => {
    const filter = new OneEuroFilter(1, 0, 1);
    filter.filter(0, 0);
    const first = filter.filter(1, 33);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.5);
    let value = first;
    for (let t = 66; t <= 3000; t += 33) {
      const next = filter.filter(1, t);
      expect(next).toBeGreaterThanOrEqual(value);
      value = next;
    }
    expect(value).toBeCloseTo(1, 2);
  });

  it('lags less on a fast move when beta is higher', () => {
    const slow = new OneEuroFilter(1, 0, 1);
    const fast = new OneEuroFilter(1, 50, 1);
    for (const f of [slow, fast]) {
      f.filter(0, 0);
      f.filter(1, 33);
    }
    expect(fast.filter(1, 66)).toBeGreaterThan(slow.filter(1, 66));
  });

  it('keeps the last output for a repeated timestamp and forgets everything on reset', () => {
    const filter = new OneEuroFilter();
    filter.filter(0, 0);
    const out = filter.filter(1, 33);
    expect(filter.filter(5, 33)).toBe(out);
    filter.reset();
    expect(filter.filter(9, 100)).toBe(9);
  });

  it('smooths a point on both axes and starts over after reset', () => {
    const smoother = new PointSmoother({ minCutoff: 1, beta: 0 });
    smoother.filter(0, 0, 0);
    const p = smoother.filter(1, 1, 33);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(1);
    expect(p.y).toBeCloseTo(p.x);
    smoother.reset();
    expect(smoother.filter(0.4, 0.6, 500)).toEqual({ x: 0.4, y: 0.6 });
  });
});

describe('HoldGate', () => {
  let gate: HoldGate<number>;

  // Arms the gate by showing neutral from `from` for 200 ms.
  function arm(from: number): void {
    gate.step(null, from);
    gate.step(null, from + 100);
    expect(gate.step(null, from + 200).armed).toBeTrue();
  }

  beforeEach(() => {
    gate = new HoldGate<number>({ holdMs: 500 });
  });

  it('does not select before it has seen neutral', () => {
    for (let t = 0; t <= 2000; t += 50) {
      const step = gate.step(1, t);
      expect(step.armed).toBeFalse();
      expect(step.selected).toBeUndefined();
      expect(step.progress).toBe(0);
    }
  });

  it('arms after neutral has lasted armMs, and not before', () => {
    expect(gate.step(null, 0).armed).toBeFalse();
    expect(gate.step(null, 150).armed).toBeFalse();
    expect(gate.step(null, 200).armed).toBeTrue();
  });

  it('restarts the neutral timer when a choice appears during arming', () => {
    gate.step(null, 0);
    gate.step(null, 150);
    gate.step(1, 180);
    gate.step(null, 200);
    expect(gate.step(null, 350).armed).toBeFalse();
    expect(gate.step(null, 400).armed).toBeTrue();
  });

  it('reports hold progress and selects when the hold completes', () => {
    arm(0);
    expect(gate.step(1, 300)).toEqual({ armed: true, choice: 1, progress: 0 });
    expect(gate.step(1, 550).progress).toBeCloseTo(0.5);
    const done = gate.step(1, 800);
    expect(done.selected).toBe(1);
    expect(done.progress).toBe(1);
    expect(done.armed).toBeFalse();
  });

  it('selects a choice of 0', () => {
    arm(0);
    gate.step(0, 300);
    const done = gate.step(0, 800);
    expect(done.selected).toBe(0);
  });

  it('selects once, then stays locked until neutral is seen again', () => {
    arm(0);
    gate.step(1, 300);
    expect(gate.step(1, 800).selected).toBe(1);
    for (let t = 850; t <= 3000; t += 50) {
      const step = gate.step(1, t);
      expect(step.selected).toBeUndefined();
      expect(step.armed).toBeFalse();
    }
    arm(3100);
    gate.step(1, 3400);
    expect(gate.step(1, 3900).selected).toBe(1);
  });

  it('ignores a flicker shorter than the grace period', () => {
    arm(0);
    gate.step(1, 300);
    expect(gate.step(1, 500).progress).toBeCloseTo(0.4);
    // 100 ms of nothing, then the same choice again: the hold carries on, not restarts.
    expect(gate.step(null, 600).choice).toBe(1);
    const back = gate.step(1, 700);
    expect(back.progress).toBeCloseTo(0.8);
    expect(gate.step(1, 800).selected).toBe(1);
  });

  it('ignores a brief other choice too', () => {
    arm(0);
    gate.step(1, 300);
    gate.step(2, 400);
    expect(gate.step(1, 450).progress).toBeCloseTo(0.3);
  });

  it('restarts the hold when a different choice lasts past the grace period', () => {
    arm(0);
    gate.step(1, 300);
    gate.step(1, 600);
    gate.step(2, 650);
    gate.step(2, 750);
    // The new choice is credited from when it first appeared (650), not from the end of the grace.
    const switched = gate.step(2, 800);
    expect(switched.choice).toBe(2);
    expect(switched.progress).toBeCloseTo(0.3);
    expect(gate.step(2, 1100).progress).toBeCloseTo(0.9);
    expect(gate.step(2, 1150).selected).toBe(2);
  });

  it('drops the hold when the choice disappears for longer than the grace period', () => {
    arm(0);
    gate.step(1, 300);
    gate.step(1, 600);
    gate.step(null, 650);
    expect(gate.step(null, 820)).toEqual({ armed: true, choice: null, progress: 0 });
    // A new hold starts from scratch.
    expect(gate.step(1, 900).progress).toBe(0);
    expect(gate.step(1, 1150).progress).toBeCloseTo(0.5);
  });

  it('is cleared by a long pause between steps', () => {
    arm(0);
    gate.step(1, 300);
    const afterPause = gate.step(1, 5000);
    expect(afterPause.selected).toBeUndefined();
    expect(afterPause.armed).toBeFalse();
  });

  it('lock() and reset() require neutral again, and arm() skips it', () => {
    arm(0);
    gate.lock();
    expect(gate.step(1, 300).armed).toBeFalse();
    arm(400);
    gate.reset();
    expect(gate.step(1, 700).armed).toBeFalse();
    gate.arm();
    expect(gate.step(1, 800).armed).toBeTrue();
    expect(gate.step(1, 1300).selected).toBe(1);
  });
});

describe('eyeRoll and headSignal', () => {
  it('is zero for level eyes and ignores which eye is first', () => {
    expect(eyeRoll({ x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }, 640, 480)).toBeCloseTo(0);
    expect(eyeRoll({ x: 0.6, y: 0.5 }, { x: 0.4, y: 0.5 }, 640, 480)).toBeCloseTo(0);
  });

  it('measures the angle in pixels, not in normalized units', () => {
    // dx = 0.2 * 800 = 160 px, dy = 0.2 * 400 = 80 px
    expect(eyeRoll({ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.6 }, 800, 400)).toBeCloseTo(
      (Math.atan(0.5) * 180) / Math.PI,
    );
    expect(eyeRoll({ x: 0.6, y: 0.6 }, { x: 0.4, y: 0.4 }, 800, 400)).toBeCloseTo(
      (Math.atan(0.5) * 180) / Math.PI,
    );
  });

  it('picks the roll, the shift or the stronger one by control mode', () => {
    // shift = (0.6 - 0.5) / 0.2 = 0.5 eye spans, so shiftSignal = 0.5 / 0.4 * 8 = 10
    const tilt = headSignal(4, 0.6, 0.5, 0.2, 'tilt');
    expect(tilt.signal).toBe(4);
    expect(tilt.source).toBe('tilt');
    expect(tilt.shift).toBeCloseTo(0.5);
    const move = headSignal(4, 0.6, 0.5, 0.2, 'move');
    expect(move.signal).toBeCloseTo(10);
    expect(move.source).toBe('move');
    const easyMove = headSignal(4, 0.6, 0.5, 0.2);
    expect(easyMove.signal).toBeCloseTo(10);
    expect(easyMove.source).toBe('move');
    const easyTilt = headSignal(12, 0.6, 0.5, 0.2);
    expect(easyTilt.signal).toBe(12);
    expect(easyTilt.source).toBe('tilt');
  });

  it('does not blow up with a tiny eye span', () => {
    expect(Number.isFinite(headSignal(0, 0.6, 0.5, 0).signal)).toBeTrue();
  });
});

describe('TiltGate', () => {
  let gate: TiltGate;

  // Holds a roll for `ms`, stepping every `dt`, and returns the steps.
  function hold(raw: number, from: number, ms: number, dt = 50): TiltStep[] {
    const steps: TiltStep[] = [];
    for (let t = from; t <= from + ms; t += dt) {
      steps.push(gate.step(raw, 1, t));
    }
    return steps;
  }

  beforeEach(() => {
    gate = new TiltGate();
  });

  it('waits at first and arms once the head has been centered for 180 ms', () => {
    expect(gate.step(0, 1, 0).waiting).toBeTrue();
    expect(gate.step(0, 1, 100).waiting).toBeTrue();
    expect(gate.step(0, 1, 200).waiting).toBeFalse();
  });

  it('does not select a tilt held from the start, only after returning to the middle', () => {
    const steps = hold(15, 0, 3000);
    expect(steps.every(s => s.waiting && s.selected === undefined)).toBeTrue();
  });

  it('selects left after the tilt has been held for the hold time', () => {
    hold(0, 0, 250);
    const steps = hold(12, 300, 1000);
    const selected = steps.find(s => s.selected);
    expect(selected?.selected).toBe('left');
    // The smoothed angle needs a step to reach the threshold; after that progress grows by 50 ms
    // per step against a 450 ms hold.
    expect(steps[0].side).toBeNull();
    expect(steps[1].side).toBe('left');
    expect(steps[1].progress).toBe(0);
    expect(steps[2].progress).toBeCloseTo(50 / 450);
  });

  it('selects right for a negative roll', () => {
    hold(0, 0, 250);
    const steps = hold(-12, 300, 1000);
    expect(steps.find(s => s.selected)?.selected).toBe('right');
  });

  it('needs the head back in the middle after a selection', () => {
    hold(0, 0, 250);
    hold(12, 300, 1000);
    const after = hold(12, 1400, 1000);
    expect(after.every(s => s.selected === undefined)).toBeTrue();
    expect(after[0].waiting).toBeTrue();
    hold(0, 2500, 300);
    expect(hold(12, 2900, 1000).some(s => s.selected === 'left')).toBeTrue();
  });

  it('cancels the hold when the head returns to the middle or switches side', () => {
    hold(0, 0, 250);
    gate.step(12, 1, 300);
    expect(gate.step(12, 1, 350).side).toBe('left');
    const back = gate.step(0, 1, 400);
    expect(back.side).toBeNull();
    expect(back.progress).toBe(0);
    // The filter lags, so give the smoothed angle time to follow before expecting the other side.
    const right = hold(-15, 450, 500);
    expect(right.some(s => s.side === 'right')).toBeTrue();
    expect(right.some(s => s.side === 'left')).toBeFalse();
  });

  it('ignores a small tremor that stays above the release threshold', () => {
    hold(0, 0, 250);
    gate.step(12, 1, 300);
    gate.step(12, 1, 350);
    // 6 degrees is below the 8 degree entry threshold but above the release threshold (4.8).
    expect(gate.step(6, 1, 400).side).toBe('left');
  });

  it('is invalid and resets when there is not exactly one face', () => {
    hold(0, 0, 250);
    expect(gate.step(0, 0, 300)).toEqual({ progress: 0, side: null, invalid: true });
    expect(gate.step(0, 2, 350).invalid).toBeTrue();
    expect(gate.step(NaN, 1, 400).invalid).toBeTrue();
    expect(gate.step(0, 1, 450).waiting).toBeTrue();
  });

  it('resets after a long pause between steps', () => {
    hold(0, 0, 250);
    expect(gate.step(0, 1, 5000).waiting).toBeTrue();
  });

  it('lock() requires the middle again', () => {
    hold(0, 0, 250);
    gate.lock();
    expect(gate.step(0, 1, 300).waiting).toBeTrue();
  });

  it('honors the threshold and hold options', () => {
    hold(0, 0, 250);
    const steps: TiltStep[] = [];
    for (let t = 300; t <= 700; t += 50) {
      steps.push(gate.step(20, 1, t, { threshold: 15, hold: 200 }));
    }
    expect(steps.find(s => s.selected)?.selected).toBe('left');
  });
});

describe('countExtendedFingers', () => {
  it('counts 0 to 4 extended fingers on an upright hand', () => {
    expect(countExtendedFingers(upright([false, false, false, false]))).toBe(0);
    expect(countExtendedFingers(upright([true, false, false, false]))).toBe(1);
    expect(countExtendedFingers(upright([true, true, false, false]))).toBe(2);
    expect(countExtendedFingers(upright([true, true, true, false]))).toBe(3);
    expect(countExtendedFingers(upright([true, true, true, true]))).toBe(4);
  });

  it('counts the same fingers wherever they are, not only the first ones', () => {
    expect(countExtendedFingers(upright([false, false, true, true]))).toBe(2);
    expect(countExtendedFingers(upright([false, true, false, true]))).toBe(2);
  });

  it('does not depend on the hand pointing up', () => {
    // Rotate the whole hand 90 degrees about the wrist: still 3 extended fingers.
    const rotated = upright([true, true, true, false]).map(p => ({
      x: 0.5 - (p.y - 0.9),
      y: 0.9 + (p.x - 0.5),
      z: 0,
    }));
    expect(countExtendedFingers(rotated)).toBe(3);
  });

  it('keeps a finger that is only slightly farther than its joint from counting', () => {
    const hand = upright([false, false, false, false]);
    // Wrist to PIP is 0.4; a tip at 0.42 is farther but under the 1.1 ratio (0.44).
    hand[8] = { x: 0.42, y: 0.48, z: 0 };
    expect(countExtendedFingers(hand)).toBe(0);
    expect(countExtendedFingers(hand, 1, 1.0)).toBe(1);
  });

  it('returns 0 for an incomplete landmark list', () => {
    expect(countExtendedFingers([])).toBe(0);
  });
});

describe('pinchRatio and PinchDetector', () => {
  let detector: PinchDetector;

  beforeEach(() => {
    detector = new PinchDetector();
  });

  it('measures the thumb-index gap relative to the hand size', () => {
    expect(pinchRatio(pinching(0.06))).toBeCloseTo(0.2);
    expect(pinchRatio(pinching(0.3))).toBeCloseTo(1);
    expect(pinchRatio([])).toBe(Infinity);
  });

  it('does not change when the whole hand is scaled (moved nearer to the camera)', () => {
    const near = pinching(0.06).map(p => ({
      x: 0.5 + (p.x - 0.5) * 1.5,
      y: 0.9 + (p.y - 0.9) * 1.5,
      z: 0,
    }));
    expect(pinchRatio(near)).toBeCloseTo(pinchRatio(pinching(0.06)));
  });

  it('reports a press only after the pinch has lasted the debounce time', () => {
    expect(detector.step(pinching(0.05), 0)).toEqual(
      jasmine.objectContaining({ pinched: false, changed: null }),
    );
    expect(detector.step(pinching(0.05), 40).pinched).toBeFalse();
    const down = detector.step(pinching(0.05), 100);
    expect(down.pinched).toBeTrue();
    expect(down.changed).toBe('down');
    expect(detector.step(pinching(0.05), 133).changed).toBeNull();
  });

  it('ignores a one-frame blip', () => {
    detector.step(pinching(0.05), 0);
    detector.step(pinching(0.2), 33);
    expect(detector.step(pinching(0.05), 66).pinched).toBeFalse();
    expect(detector.step(pinching(0.05), 120).pinched).toBeFalse();
  });

  it('holds a pinch inside the hysteresis band and releases above the off threshold', () => {
    detector.step(pinching(0.05), 0);
    detector.step(pinching(0.05), 100);
    // ratio 0.3 sits between on (0.25) and off (0.4): still pinched, however long.
    for (let t = 133; t <= 1000; t += 33) {
      expect(detector.step(pinching(0.09), t).pinched).toBeTrue();
    }
    detector.step(pinching(0.15), 1100);
    expect(detector.step(pinching(0.15), 1150).pinched).toBeTrue();
    const up = detector.step(pinching(0.15), 1200);
    expect(up.pinched).toBeFalse();
    expect(up.changed).toBe('up');
  });

  it('does not start a pinch from a ratio in the hysteresis band', () => {
    for (let t = 0; t <= 500; t += 33) {
      expect(detector.step(pinching(0.09), t).pinched).toBeFalse();
    }
  });

  it('keeps a pinch while the hand is briefly lost, then releases', () => {
    detector.step(pinching(0.05), 0);
    detector.step(pinching(0.05), 100);
    expect(detector.step(null, 200).pinched).toBeTrue();
    expect(detector.step(null, 400).pinched).toBeTrue();
    const up = detector.step(null, 520);
    expect(up.pinched).toBeFalse();
    expect(up.changed).toBe('up');
    expect(detector.step(null, 560).changed).toBeNull();
  });

  it('forgets the lost time when the hand comes back', () => {
    detector.step(pinching(0.05), 0);
    detector.step(pinching(0.05), 100);
    detector.step(null, 150);
    expect(detector.step(pinching(0.05), 250).pinched).toBeTrue();
    expect(detector.step(null, 300).pinched).toBeTrue();
    expect(detector.step(null, 500).pinched).toBeTrue();
  });

  it('reports no ratio for a lost hand while nothing is pinched', () => {
    expect(detector.step(null, 0)).toEqual({ pinched: false, changed: null, ratio: Infinity });
  });
});

describe('BiteDetector', () => {
  let detector: BiteDetector;

  beforeEach(() => {
    detector = new BiteDetector();
  });

  it('bites once when the mouth closes after having been open', () => {
    expect(detector.step(0.05, 0)).toEqual({ open: false, bite: false });
    expect(detector.step(0.6, 33)).toEqual({ open: true, bite: false });
    expect(detector.step(0.7, 100)).toEqual({ open: true, bite: false });
    expect(detector.step(0.1, 160)).toEqual({ open: false, bite: true });
    expect(detector.step(0.05, 200).bite).toBeFalse();
    expect(detector.step(0.05, 233).bite).toBeFalse();
  });

  it('does not count a twitch shorter than minOpenMs', () => {
    detector.step(0.6, 0);
    expect(detector.step(0.1, 40).bite).toBeFalse();
  });

  it('keeps the mouth open and silent inside the hysteresis band', () => {
    detector.step(0.6, 0);
    for (let t = 50; t <= 500; t += 50) {
      expect(detector.step(0.3, t)).toEqual({ open: true, bite: false });
    }
    expect(detector.step(0.15, 550).bite).toBeTrue();
  });

  it('does not open from the band either', () => {
    expect(detector.step(0.3, 0).open).toBeFalse();
    expect(detector.step(0.4, 50).open).toBeFalse();
  });

  it('can bite again after the next opening', () => {
    detector.step(0.6, 0);
    expect(detector.step(0.1, 200).bite).toBeTrue();
    detector.step(0.6, 300);
    expect(detector.step(0.1, 500).bite).toBeTrue();
  });

  it('drops a half-finished bite on reset', () => {
    detector.step(0.6, 0);
    detector.reset();
    expect(detector.step(0.1, 300).bite).toBeFalse();
  });
});

describe('thumbChoice', () => {
  function frame(gesture: string | null, gestureScore: number): HandFrame {
    return { landmarks: blankHand(), gesture, gestureScore };
  }

  it('maps thumb up to the first option and thumb down to the second', () => {
    expect(thumbChoice(frame('Thumb_Up', 0.9))).toBe(0);
    expect(thumbChoice(frame('Thumb_Down', 0.9))).toBe(1);
  });

  it('needs a confident recognition', () => {
    expect(thumbChoice(frame('Thumb_Up', 0.5))).toBeNull();
    expect(thumbChoice(frame('Thumb_Up', 0.5), 0.4)).toBe(0);
  });

  it('ignores every other gesture and no gesture at all', () => {
    expect(thumbChoice(frame('Open_Palm', 0.99))).toBeNull();
    expect(thumbChoice(frame('Victory', 0.99))).toBeNull();
    expect(thumbChoice(frame(null, 0))).toBeNull();
    expect(thumbChoice({ landmarks: null, gesture: null, gestureScore: 0 })).toBeNull();
  });
});

describe('segHit', () => {
  it('hits a circle the segment passes through', () => {
    const hit = segHit(0, 0, 10, 0, 5, 3, 4);
    expect(hit?.t).toBeCloseTo(0.5);
    expect(hit?.d).toBeCloseTo(3);
  });

  it('misses a circle that is too far from the segment', () => {
    expect(segHit(0, 0, 10, 0, 5, 5, 4)).toBeNull();
  });

  it('measures to the nearest end when the circle is past the segment', () => {
    const hit = segHit(0, 0, 10, 0, 12, 0, 3);
    expect(hit?.t).toBe(1);
    expect(hit?.d).toBeCloseTo(2);
    expect(segHit(0, 0, 10, 0, -5, 0, 3)).toBeNull();
  });

  it('hits a target that a fast swipe jumped over between two frames', () => {
    expect(segHit(0, 0, 400, 0, 200, 10, 30)).not.toBeNull();
  });

  it('ignores a segment of no length', () => {
    expect(segHit(5, 5, 5, 5, 5, 5, 10)).toBeNull();
  });
});
