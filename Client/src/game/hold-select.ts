import { HoldGate, HoldGateStep } from './gestures';
import type { GameSound } from './game-audio';

// The pieces the two "hold a hand pose" games (true/false and finger count) have in common. They live
// with the other shared game engine files, so neither game has to import from the other.

// Keeps a reading steady against single-frame misreads: the output only changes to a new value after
// the camera has reported it `frames` times in a row, and holds the old value until then. Without it a
// one-frame misread of a fist as "one finger" would start a hold on the gate, flash its progress ring
// and play the "select" sound. The price is `frames - 1` frames of delay (about 30 ms each).
export class StableReading<T> {
  private stable: T;
  private candidate: T;
  private streak = 0;

  constructor(
    private readonly initial: T,
    private readonly frames: number,
  ) {
    this.stable = initial;
    this.candidate = initial;
  }

  step(raw: T): T {
    if (raw === this.candidate) {
      this.streak = Math.min(this.streak + 1, this.frames);
    } else {
      this.candidate = raw;
      this.streak = 1;
    }
    if (this.streak >= this.frames) {
      this.stable = this.candidate;
    }
    return this.stable;
  }

  reset(): void {
    this.stable = this.initial;
    this.candidate = this.initial;
    this.streak = 0;
  }
}

export type HoldCue = Extract<GameSound, 'select' | 'charge'> | null;

// Which sound a hold in progress should make, ported from the head-tilt prototype's `progress()`:
// "select" when a hold starts on a choice and "charge" when it passes a third and two thirds of the
// way, so the player hears it filling up. Returns at most one cue per step.
export class HoldCues {
  private choice: number | null = null;
  private bucket = 0;

  step(choice: number | null, progress: number): HoldCue {
    if (choice === null || !(progress > 0)) {
      this.choice = null;
      this.bucket = 0;
      return null;
    }
    // Capped at 2: the last third ends in the selection itself, which has its own sound.
    const bucket = Math.min(2, Math.floor(progress * 3));
    if (choice !== this.choice) {
      this.choice = choice;
      this.bucket = bucket;
      return 'select';
    }
    if (bucket > this.bucket) {
      this.bucket = bucket;
      return 'charge';
    }
    return null;
  }
}

export interface HoldSelectorStep extends HoldGateStep<number> {
  cue: HoldCue;
}

// A HoldGate plus the sounds that go with it. The games call `lock()` on every new question, so the
// player has to drop the pose (neutral) before the next answer counts.
export class HoldSelector {
  private readonly gate: HoldGate<number>;
  private readonly cues = new HoldCues();

  constructor(holdMs: number) {
    this.gate = new HoldGate<number>({ holdMs });
  }

  step(choice: number | null, now: number): HoldSelectorStep {
    const step = this.gate.step(choice, now);
    return { ...step, cue: this.cues.step(step.choice, step.progress) };
  }

  lock(): void {
    this.gate.lock();
    this.cues.step(null, 0);
  }
}

// Is the key event aimed at something the player types into? Answer keys must not steal digits or
// arrows from a text field.
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

// A key press is an answer candidate only without modifiers and outside text fields.
export function isPlainKey(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'target'>,
): boolean {
  return (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !isTypingTarget(event.target)
  );
}

// A hold-progress state both games show in their template. `choice` is what the gate is charging (null
// when nothing is, or when it is not armed) and `progress` how far (0..1).
export interface HoldView {
  armed: boolean;
  choice: number | null;
  progress: number;
}

// The view is written about every frame, so progress within 2% of the value already shown counts as
// unchanged and causes no change detection.
export function sameProgress(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.02;
}

// The circle's `stroke-dashoffset` for a ring drawn with `pathLength="100"`: 100 is empty, 0 is full.
export function ringOffset(view: HoldView, index: number): number {
  return view.choice === index ? 100 * (1 - Math.min(1, Math.max(0, view.progress))) : 100;
}
