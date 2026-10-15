import { countExtendedFingers } from '../../../../game/gestures';
import type { HandFrame } from '../../../../game/stage-game';
import { HoldView, sameProgress, StableReading } from '../../../../game/hold-select';

// The long fingers (index to pinky) are counted, so 1..4 map to the four options and a fist is
// neutral. The finger count is a steadier reading than the thumb gestures, but it flickers while the
// hand rises or turns, so a hold of 700 ms asks for a bit more than the thumb game's 600 ms.
export const FINGER_HOLD_MS = 700;
// Three frames in a row (about 100 ms) before a new count is believed. This is on top of the hold
// gate's own 150 ms of grace: the gate keeps a hold alive through a flicker, but it would still start
// one on a single misread frame, flashing the ring and playing the "select" sound; the debounce keeps
// such frames from reaching it at all.
export const FINGER_STABLE_FRAMES = 3;

// "No hand in view", kept apart from a fist (0 fingers) so the badge can say which it is. Both are
// neutral for the gate.
export const NO_HAND = -1;

export const MAX_FINGERS = 4;

// Turns the camera's hand frames into a steady finger count: NO_HAND, or 0..4. `aspect` is the
// video's width / height, which the finger test needs to measure in the same units on both axes.
export class FingerReader {
  private readonly stable = new StableReading<number>(NO_HAND, FINGER_STABLE_FRAMES);

  read(frame: HandFrame, aspect: number): number {
    const raw = frame.landmarks ? countExtendedFingers(frame.landmarks, aspect) : NO_HAND;
    return this.stable.step(raw);
  }

  reset(): void {
    this.stable.reset();
  }
}

// The option a finger count answers: one finger is the first option and so on. A fist, no hand or
// more fingers than there are options is neutral (null).
export function fingerChoice(count: number, optionCount: number): number | null {
  return count >= 1 && count <= Math.min(MAX_FINGERS, optionCount) ? count - 1 : null;
}

// What the template shows of the camera side. `count` is the steady finger count (NO_HAND for none),
// `choice` and `progress` come from the gate.
export interface FingerView extends HoldView {
  count: number;
}

export const IDLE_FINGER_VIEW: FingerView = {
  armed: false,
  choice: null,
  progress: 0,
  count: NO_HAND,
};

export function sameFingerView(a: FingerView, b: FingerView): boolean {
  return (
    a.armed === b.armed &&
    a.choice === b.choice &&
    a.count === b.count &&
    sameProgress(a.progress, b.progress)
  );
}

// The badge that always tells the player what the camera sees.
export function fingerBadge(count: number): string {
  if (count === NO_HAND) {
    return 'Chưa thấy bàn tay';
  }
  return count === 0 ? 'Đang nắm tay' : `Đang giơ: ${count} ngón`;
}

export const FINGER_HINT = 'Giơ số ngón theo đáp án (không tính ngón cái)';

// The sentence next to the badge: the standing hint, or what is happening to the hold.
export function fingerStatus(view: FingerView): string {
  if (view.choice !== null) {
    return `Đang chọn đáp án ${view.choice + 1}… ${Math.round(view.progress * 100)}%`;
  }
  if (!view.armed && view.count > 0) {
    return 'Nắm tay lại rồi chọn câu tiếp';
  }
  return FINGER_HINT;
}

// The option an answer key picks: 1..4 for the first to fourth, when it exists.
export function fingerKeyIndex(key: string, optionCount: number): number | null {
  const digit = Number(key);
  return Number.isInteger(digit) && digit >= 1 && digit <= Math.min(MAX_FINGERS, optionCount)
    ? digit - 1
    : null;
}

// Does the text contain hanzi? Only then is it set in the hanzi font, whose Vietnamese letters would
// otherwise come from a fallback.
export function hasHanzi(text: string): boolean {
  return /[㐀-鿿豈-﫿]/.test(text);
}
