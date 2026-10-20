import { mapToStage } from '../../../../game/gestures';
import type { FaceSpec } from './face-fixture';
import {
  ChargeCue,
  HeadTiltReader,
  RECALIBRATE_AFTER_MS,
  TILT_HOLD_MS,
  meterPercent,
  sideToIndex,
  tiltHint,
} from './head-tilt-logic';
import type { HeadTiltStep } from './head-tilt-logic';
import { ChargeCue, HeadTiltReader, meterPercent, sideToIndex, TILT_HOLD_MS, tiltHint, } from './head-tilt-logic';
import type { FacePose } from './face-common';

function play(
  reader: HeadTiltReader,
  spec: FaceSpec,
  from: number,
  durationMs: number,
  neutral: FacePose = NEUTRAL,
) {
  return playFrames(
    now => reader.step(faceFrame(spec), VIDEO_WIDTH, VIDEO_HEIGHT, neutral, now),
    from,
    durationMs,
  );
}

function selections(steps: HeadTiltStep[]): (0 | 1)[] {
  return steps.flatMap(step => (step.selected === null ? [] : [step.selected]));
}

describe('which way is which', () => {
  it('maps the left side to the first option and the right side to the second', () => {
    expect(sideToIndex('left')).toBe(0);
    expect(sideToIndex('right')).toBe(1);
  });

  // The player watches a mirrored preview, so the camera image's right is the screen's left.
  it('puts the image-right of the camera on the left of the mirrored stage', () => {
    const rightOfImage = mapToStage(0.7, 0.5, VIDEO_WIDTH, VIDEO_HEIGHT, 800, 450);
    const leftOfImage = mapToStage(0.3, 0.5, VIDEO_WIDTH, VIDEO_HEIGHT, 800, 450);
    expect(rightOfImage.x).toBeLessThan(400);
    expect(leftOfImage.x).toBeGreaterThan(400);
  });

  it('moves the meter dot toward the end the player leans to', () => {
    expect(meterPercent(0)).toBe(50);
    expect(meterPercent(1)).toBeLessThan(10);
    expect(meterPercent(-1)).toBeGreaterThan(90);
    expect(meterPercent(5)).toBe(meterPercent(1));
  });
});

describe('ChargeCue', () => {
  it('plays select when a side starts and charge at a third and two thirds', () => {
    const cue = new ChargeCue();
    expect(cue.step('left', 0.1)).toBe('select');
    expect(cue.step('left', 0.2)).toBeNull();
    expect(cue.step('left', 0.4)).toBe('charge');
    expect(cue.step('left', 0.5)).toBeNull();
    expect(cue.step('left', 0.7)).toBe('charge');
    expect(cue.step('left', 0.95)).toBeNull();
  });

  it('starts over on another side or after a release', () => {
    const cue = new ChargeCue();
    expect(cue.step('left', 0.5)).toBe('select');
    expect(cue.step('right', 0.1)).toBe('select');
    expect(cue.step(null, 0)).toBeNull();
    expect(cue.step('right', 0.1)).toBe('select');
  });
});

describe('HeadTiltReader', () => {
  it('chooses the left card (option 0) for a lean toward the screen left, held', () => {
    const reader = new HeadTiltReader();
    const rest = play(reader, { roll: 0 }, 0, 400);
    const lean = play(reader, { roll: 14 }, rest.end, 900);

    expect(selections(rest.results)).toEqual([]);
    expect(selections(lean.results)).toEqual([0]);
  });

  it('chooses the right card (option 1) for a lean toward the screen right', () => {
    const reader = new HeadTiltReader();
    const rest = play(reader, { roll: 0 }, 0, 400);
    const lean = play(reader, { roll: -14 }, rest.end, 900);

    expect(selections(lean.results)).toEqual([1]);
  });

  it('also accepts a head shift: toward larger image x is the left card', () => {
    const left = new HeadTiltReader();
    const leftRest = play(left, {}, 0, 400);
    // 0.12 of the image is 0.6 eye spans: with the 0.4 shift threshold that is a clear lean.
    const leftShift = play(left, { centerX: 0.62 }, leftRest.end, 900);
    expect(selections(leftShift.results)).toEqual([0]);

    const right = new HeadTiltReader();
    const rightRest = play(right, {}, 0, 400);
    const rightShift = play(right, { centerX: 0.38 }, rightRest.end, 900);
    expect(selections(rightShift.results)).toEqual([1]);
  });

  it('measures against the calibrated neutral, not against zero', () => {
    const neutral: FacePose = {
      roll: 6,
      centerX: 0.45,
      noseX: 0.45,
      eyeSpan: 0.2
    };
    const reader = new HeadTiltReader();
    // Resting exactly in the neutral pose, which is tilted and off-centre on its own.
    const rest = play(reader, {
      roll: 6,
      centerX: 0.45
    }, 0, 2000, neutral);
    expect(selections(rest.results)).toEqual([]);

    const lean = play(reader, {
      roll: 6 + 14,
      centerX: 0.45
    }, rest.end, 900, neutral);
    expect(selections(lean.results)).toEqual([0]);
  });

  it('needs the hold: a lean released early chooses nothing', () => {
    const reader = new HeadTiltReader();
    const rest = play(reader, {}, 0, 400);
    const brief = play(reader, { roll: 14 }, rest.end, TILT_HOLD_MS / 2);
    const back = play(reader, {}, brief.end, 600);
    expect(selections([...brief.results, ...back.results])).toEqual([]);
    expect(Math.max(...brief.results.map(step => step.progress))).toBeLessThan(1);
  });

  it('ignores a small tilt', () => {
    const reader = new HeadTiltReader();
    const rest = play(reader, {}, 0, 400);
    const small = play(reader, { roll: 3 }, rest.end, 3000);
    expect(selections(small.results)).toEqual([]);
  });

  it('does not choose while the head has not been in the middle yet', () => {
    const reader = new HeadTiltReader();
    const leaning = play(reader, { roll: 14 }, 0, 2000);
    expect(selections(leaning.results)).toEqual([]);
    expect(leaning.results.every(step => step.waiting)).toBeTrue();
  });

  it('needs the head back in the middle after a choice and after lock()', () => {
    const reader = new HeadTiltReader();
    const rest = play(reader, {}, 0, 400);
    const first = play(reader, { roll: 14 }, rest.end, 900);
    expect(selections(first.results)).toEqual([0]);

    // Still leaning: the same lean does not answer again.
    const stillLeaning = play(reader, { roll: 14 }, first.end, 2000);
    expect(selections(stillLeaning.results)).toEqual([]);

    // Back to the middle, then a new lean: it counts again.
    const middle = play(reader, {}, stillLeaning.end, 400);
    const again = play(reader, { roll: -14 }, middle.end, 900);
    expect(selections(again.results)).toEqual([1]);

    // lock() is what a new question does: leaning from before it must be released first.
    reader.lock();
    const carried = play(reader, { roll: -14 }, again.end, 2000);
    expect(selections(carried.results)).toEqual([]);
  });

  it('asks for a new calibration when the head stays off the middle', () => {
    const reader = new HeadTiltReader();
    // Settled 0.3 eye spans to one side of the calibrated neutral: no lean, but not the middle either.
    const early = play(reader, { centerX: 0.56 }, 0, RECALIBRATE_AFTER_MS - 200);
    const late = play(reader, { centerX: 0.56 }, early.end, 400);

    expect(early.results.every(step => step.waiting && !step.recalibrate)).toBeTrue();
    expect(late.results.some(step => step.recalibrate)).toBeTrue();
    expect(selections([...early.results, ...late.results])).toEqual([]);
  });

  it('does not count a pause as waiting, and stops waiting once the head is in the middle', () => {
    const reader = new HeadTiltReader();
    const off = play(reader, { centerX: 0.56 }, 0, RECALIBRATE_AFTER_MS - 1000);
    const resumed = play(reader, { centerX: 0.56 }, off.end + 10_000, 300);
    const middle = play(reader, {}, resumed.end, 400);
    const offAgain = play(reader, { centerX: 0.56 }, middle.end, RECALIBRATE_AFTER_MS + 500);

    const all = [...off.results, ...resumed.results, ...middle.results, ...offAgain.results];
    expect(all.some(step => step.recalibrate)).toBeFalse();
  });

  it('chooses nothing and reports why while the face count is not one', () => {
    const reader = new HeadTiltReader();
    const rest = play(reader, {}, 0, 400);

    const crowd = play(reader, {
      roll: 14,
      faces: 2
    }, rest.end, 2000);
    expect(selections(crowd.results)).toEqual([]);
    expect(crowd.results.every(step => step.invalid)).toBeTrue();
    expect(crowd.results[0].problem).toBe('Chỉ một người trước camera');

    const none = play(reader, { faces: 0 }, crowd.end, 200);
    expect(none.results[0].problem).toBe('Chưa thấy mặt · đến gần và nhìn camera');
  });

  it('forgets a hold in progress when the face is lost and starts from the middle again', () => {
    const reader = new HeadTiltReader();
    const rest = play(reader, {}, 0, 400);
    const holding = play(reader, { roll: 14 }, rest.end, 300);
    expect(holding.results[holding.results.length - 1].progress).toBeGreaterThan(0);

    const lost = play(reader, { faces: 0 }, holding.end, 100);
    // Back with the head still leaning: it has to return to the middle first.
    const back = play(reader, { roll: 14 }, lost.end, 2000);
    expect(selections(back.results)).toEqual([]);
  });

  it('reports the lean in units of the threshold and charges the card it leans to', () => {
    const reader = new HeadTiltReader();
    const rest = play(reader, {}, 0, 400);
    const lean = play(reader, { roll: 14 }, rest.end, 200);
    const last = lean.results[lean.results.length - 1];
    expect(last.side).toBe('left');
    expect(last.lean).toBeGreaterThan(1);
    expect(last.progress).toBeGreaterThan(0);
    expect(lean.results.some(step => step.cue === 'select')).toBeTrue();
  });
});

describe('tiltHint', () => {
  const idle: HeadTiltStep = {
    invalid: false,
    problem: null,
    waiting: false,
    recalibrate: false,
    side: null,
    progress: 0,
    lean: 0,
    selected: null,
    cue: null,
  };

  it('prefers the face problem, then waiting, then the side being held', () => {
    expect(tiltHint({
      ...idle,
      invalid: true,
      problem: 'Chưa thấy mặt'
    })).toBe('Chưa thấy mặt');
    expect(tiltHint({
      ...idle,
      waiting: true
    })).toBe('Đưa đầu về giữa một chút');
    expect(tiltHint({
      ...idle,
      side: 'left',
      progress: 0.45
    })).toBe('Giữ TRÁI · 45%');
    expect(tiltHint({
      ...idle,
      side: 'right',
      progress: 0.9
    })).toBe('Giữ PHẢI · 90%');
  });

  it('encourages a bigger lean or explains the control', () => {
    expect(tiltHint({
      ...idle,
      lean: 0.5
    })).toBe('Thêm một chút về phía đáp án');
    expect(tiltHint({
      ...idle,
      lean: -0.5
    })).toBe('Thêm một chút về phía đáp án');
    expect(tiltHint(idle)).toBe('Nghiêng hoặc dịch đầu nhẹ để chọn');
  });
});
