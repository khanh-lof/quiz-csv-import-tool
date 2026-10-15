import { thumbChoice } from '../../../../game/gestures';
import type { HandFrame } from '../../../../game/stage-game';
import { HoldView, sameProgress, StableReading } from '../../../../game/hold-select';

// MediaPipe's gesture score a thumb has to reach, and how long the thumb is held to answer. The
// recognizer is steady, so a short hold is enough, but long enough that a thumb passing through on the
// way up or down does not answer.
export const THUMB_MIN_SCORE = 0.6;
export const THUMB_HOLD_MS = 600;
// Two frames in a row (about 60 ms) before a change of pose is believed.
export const THUMB_STABLE_FRAMES = 2;

// Option index of each answer: the page always sends ['Đúng', 'Sai'] for stage 1.
export const TRUE_INDEX = 0;
export const FALSE_INDEX = 1;

export interface ThumbTarget {
  index: number;
  emoji: string;
  label: string;
  // The keys that answer it, shown on the card.
  keys: string;
}

// In screen order: Đúng on the left, Sai on the right, whatever the camera mirroring.
export const THUMB_TARGETS: readonly ThumbTarget[] = [
  {
    index: TRUE_INDEX,
    emoji: '👍',
    label: 'Đúng',
    keys: '1 · ←'
  },
  {
    index: FALSE_INDEX,
    emoji: '👎',
    label: 'Sai',
    keys: '2 · →'
  },
];

// Turns the camera's hand frames into the choice the hold gate watches: 0 for thumb up, 1 for thumb
// down, null for anything else, including no hand. Flicker of a frame or two is smoothed away.
export class ThumbReader {
  private readonly stable = new StableReading<0 | 1 | null>(null, THUMB_STABLE_FRAMES);

  read(frame: HandFrame): 0 | 1 | null {
    const raw = frame.landmarks ? thumbChoice(frame, THUMB_MIN_SCORE) : null;
    return this.stable.step(raw);
  }

  reset(): void {
    this.stable.reset();
  }
}

// What the template shows of the camera side. `shown` is the thumb the camera currently sees (null
// for neutral or no hand), `choice` and `progress` come from the gate.
export interface ThumbView extends HoldView {
  shown: 0 | 1 | null;
}

export const IDLE_THUMB_VIEW: ThumbView = {
  armed: false,
  choice: null,
  progress: 0,
  shown: null
};

export function sameThumbView(a: ThumbView, b: ThumbView): boolean {
  return (
    a.armed === b.armed &&
    a.choice === b.choice &&
    a.shown === b.shown &&
    sameProgress(a.progress, b.progress)
  );
}

// The line under the targets that tells the player what the camera is doing.
export function thumbStatus(view: ThumbView): string {
  if (view.choice !== null) {
    const target = THUMB_TARGETS.find(candidate => candidate.index === view.choice);
    return `Đang chọn ${target?.label ?? ''}… ${Math.round(view.progress * 100)}%`;
  }
  if (!view.armed && view.shown !== null) {
    return 'Hạ tay xuống rồi chọn câu tiếp';
  }
  return 'Giơ ngón cái lên hoặc chúc xuống';
}

// The option an answer key picks: 1 or ← for Đúng, 2 or → for Sai.
export function thumbKeyIndex(key: string): number | null {
  if (key === '1' || key === 'ArrowLeft') {
    return TRUE_INDEX;
  }
  if (key === '2' || key === 'ArrowRight') {
    return FALSE_INDEX;
  }
  return null;
}
