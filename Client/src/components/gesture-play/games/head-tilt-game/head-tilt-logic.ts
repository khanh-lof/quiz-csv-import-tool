import type { TiltSide } from '../../../../game/gestures';
import { clamp, headSignal, TiltGate } from '../../../../game/gestures';
import type { FaceFrame } from '../../../../game/stage-game';
import type { FacePose } from './face-common';
import { faceProblemMessage, readFacePose } from './face-common';

// The head-tilt prototype's "easy" control with its defaults: a lean of 8 degrees of roll, or a head
// shift of 0.4 eye spans (which headSignal scales to the same units), held for 450 ms.
export const TILT_THRESHOLD_DEG = 8;
export const SHIFT_THRESHOLD_SPANS = 0.4;
export const TILT_HOLD_MS = 450;

// How long the head may stay off the middle while a choice waits for it there, before the neutral
// pose is measured again. A player who has settled a little to one side since calibrating (the
// middle is only a fifth of an eye span wide) would otherwise never get back to it, and no lean
// would ever count.
export const RECALIBRATE_AFTER_MS = 2000;

// Frames further apart than this (the game was paused, the tab hidden) count as this long.
const MAX_FRAME_MS = 150;

// Which card a side selects. `TiltGate` follows the prototype's sign convention: a positive signal
// is 'left'. In the mirrored preview the player sees, that is a lean toward the screen's left: a
// positive roll has the image's right-hand eye lower, which is the player's left eye, and a positive
// shift is the head moving toward larger x in the unmirrored image, which is the player's left
// again. The player's left is the screen's left in the mirror, so 'left' is the left card, the
// first option.
export function sideToIndex(side: TiltSide): 0 | 1 {
  return side === 'left' ? 0 : 1;
}

// Where the meter's dot sits, as a percentage from the left: a full lean toward the left card puts
// it near the left end. `lean` is the signal in units of the threshold (+1 = enough to choose left).
export function meterPercent(lean: number): number {
  return 50 - clamp(lean, -1, 1) * 46;
}

// Sounds for a side charging up, as in the prototype: one 'select' when a side starts, then a
// 'charge' at a third and two thirds of the hold.
export type ChargeSound = 'select' | 'charge';

export class ChargeCue {
  private side: TiltSide | null = null;
  private bucket = 0;

  step(side: TiltSide | null, progress: number): ChargeSound | null {
    if (!side || !progress) {
      this.reset();
      return null;
    }
    if (side !== this.side) {
      this.side = side;
      this.bucket = 0;
      return 'select';
    }
    const bucket = Math.floor(progress * 3);
    if (bucket > this.bucket && bucket < 3) {
      this.bucket = bucket;
      return 'charge';
    }
    return null;
  }

  reset(): void {
    this.side = null;
    this.bucket = 0;
  }
}

export interface HeadTiltStep {
  // No single usable face this frame; `problem` says why in words.
  invalid: boolean;
  problem: string | null;
  // The head is not near the middle yet, so no choice counts.
  waiting: boolean;
  // It has been waiting for RECALIBRATE_AFTER_MS: the neutral pose should be measured again.
  recalibrate: boolean;
  side: TiltSide | null;
  // 0..1 of the hold.
  progress: number;
  // The smoothed signal in units of the threshold: +1 is a full lean toward the left card.
  lean: number;
  // The option index chosen on this one step (0 = left card, 1 = right card), else null.
  selected: 0 | 1 | null;
  cue: ChargeSound | null;
}

// A face frame in, a left/right choice out: the pose against the calibrated neutral becomes one
// signal (`headSignal`, 'easy'), which the `TiltGate` smooths, arms on the middle and holds.
export class HeadTiltReader {
  private readonly gate = new TiltGate();
  private readonly cues = new ChargeCue();
  private last: number | null = null;
  private waitedMs = 0;

  step(
    face: FaceFrame,
    videoW: number,
    videoH: number,
    neutral: FacePose,
    now: number,
  ): HeadTiltStep {
    const dt = this.last === null ? 0 : Math.min(Math.max(now - this.last, 0), MAX_FRAME_MS);
    this.last = now;
    const pose = readFacePose(face, videoW, videoH);
    if (!pose) {
      this.gate.step(Number.NaN, face.faces, now);
      this.cues.reset();
      this.waitedMs = 0;
      return {
        invalid: true,
        problem: faceProblemMessage(face.faces) ?? faceProblemMessage(0),
        waiting: false,
        recalibrate: false,
        side: null,
        progress: 0,
        lean: 0,
        selected: null,
        cue: null,
      };
    }

    const { signal } = headSignal(
      pose.roll - neutral.roll,
      pose.centerX,
      neutral.centerX,
      pose.eyeSpan,
      'easy',
      SHIFT_THRESHOLD_SPANS,
      TILT_THRESHOLD_DEG,
    );
    const result = this.gate.step(signal, 1, now, {
      threshold: TILT_THRESHOLD_DEG,
      hold: TILT_HOLD_MS,
    });
    const waiting = result.waiting === true;
    this.waitedMs = waiting ? this.waitedMs + dt : 0;
    return {
      invalid: false,
      problem: null,
      waiting,
      recalibrate: this.waitedMs >= RECALIBRATE_AFTER_MS,
      side: result.side,
      progress: result.progress,
      lean: (result.angle ?? 0) / TILT_THRESHOLD_DEG,
      selected: result.selected === undefined ? null : sideToIndex(result.selected),
      cue: this.cues.step(result.side, result.progress),
    };
  }

  // A new question: the head has to be back in the middle before the next choice counts.
  lock(): void {
    this.gate.lock();
    this.cues.reset();
    this.waitedMs = 0;
  }

  reset(): void {
    this.gate.reset();
    this.cues.reset();
    this.last = null;
    this.waitedMs = 0;
  }
}

// What the hint under the meter says, in the prototype's words.
export function tiltHint(step: HeadTiltStep): string {
  if (step.problem) {
    return step.problem;
  }
  if (step.waiting) {
    return 'Đưa đầu về giữa một chút';
  }
  if (step.side) {
    return `Giữ ${step.side === 'left' ? 'TRÁI' : 'PHẢI'} · ${Math.round(step.progress * 100)}%`;
  }
  return Math.abs(step.lean) > 0.25
    ? 'Thêm một chút về phía đáp án'
    : 'Nghiêng hoặc dịch đầu nhẹ để chọn';
}
