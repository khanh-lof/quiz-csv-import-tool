import type { HandFrame, Point3 } from './stage-game';

// Pure, framework-free helpers shared by the six gesture games: coordinate mapping, smoothing, the
// "hold a choice" selectors and the hand/face gesture detectors. Nothing here touches the DOM or
// MediaPipe, so every piece is unit-testable with synthetic landmarks.

// MediaPipe landmark indices. Face: the outer eye corners give the head roll and the nose tip
// anchors the head position. Hand: the standard 21-point layout.
export const FACE_LEFT_EYE_OUTER = 33;
export const FACE_RIGHT_EYE_OUTER = 263;
export const FACE_NOSE_TIP = 1;

export const WRIST = 0;
export const THUMB_TIP = 4;
export const INDEX_PIP = 6;
export const INDEX_TIP = 8;
export const MIDDLE_MCP = 9;

type XY = { x: number; y: number };

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// The camera preview is shown mirrored like a mirror, but MediaPipe reports the unmirrored image,
// so a game that draws on the preview flips x itself.
export function mirrorX(x: number): number {
  return 1 - x;
}

// Maps a normalized landmark to stage pixels for a video shown with `object-fit: cover` (scaled
// until it fills the stage, the overflow cropped evenly on both sides) and, by default, mirrored. A
// video with no size yet (camera still starting) falls back to stretching over the stage.
export function mapToStage(
  nx: number,
  ny: number,
  videoW: number,
  videoH: number,
  stageW: number,
  stageH: number,
  mirrored = true,
): XY {
  if (!(videoW > 0) || !(videoH > 0)) {
    return { x: (mirrored ? mirrorX(nx) : nx) * stageW, y: ny * stageH };
  }
  const scale = Math.max(stageW / videoW, stageH / videoH);
  const drawnW = videoW * scale;
  const drawnH = videoH * scale;
  const x = (stageW - drawnW) / 2 + nx * drawnW;
  return { x: mirrored ? stageW - x : x, y: (stageH - drawnH) / 2 + ny * drawnH };
}

// Landmarks are normalized per axis, so on a 16:9 image a step of 0.1 in x is longer than one in y.
// `aspect` (videoWidth / videoHeight) scales x so distances are the same in every direction.
export function dist2d(a: XY, b: XY, aspect = 1): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

// The 1-euro filter: strong smoothing while the value is nearly still (kills jitter) and almost
// none while it moves fast (no lag on a sweep). `beta` scales how quickly the cutoff opens up with
// speed; its useful size depends on the units of the value (per second), so tune it per use.
export class OneEuroFilter {
  private previousRaw: number | null = null;
  private previous = 0;
  private derivative = 0;
  private previousTime = 0;

  constructor(
    private readonly minCutoff = 1.2,
    private readonly beta = 6,
    private readonly dCutoff = 1,
  ) {}

  filter(value: number, tMs: number): number {
    if (this.previousRaw === null) {
      this.previousRaw = value;
      this.previous = value;
      this.derivative = 0;
      this.previousTime = tMs;
      return value;
    }
    const dt = (tMs - this.previousTime) / 1000;
    if (!(dt > 0)) {
      // Two readings with the same timestamp carry no speed information; keep the last output.
      return this.previous;
    }
    const rawSpeed = (value - this.previousRaw) / dt;
    this.derivative += OneEuroFilter.alpha(this.dCutoff, dt) * (rawSpeed - this.derivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative);
    this.previous += OneEuroFilter.alpha(cutoff, dt) * (value - this.previous);
    this.previousRaw = value;
    this.previousTime = tMs;
    return this.previous;
  }

  reset(): void {
    this.previousRaw = null;
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
}

export interface PointSmootherOptions {
  minCutoff?: number;
  beta?: number;
  dCutoff?: number;
}

// Two 1-euro filters, one per axis. The defaults suit normalized 0..1 coordinates (speeds of about
// 1 per second); for pixels, divide `beta` by the stage size.
export class PointSmoother {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor({ minCutoff = 1.2, beta = 6, dCutoff = 1 }: PointSmootherOptions = {}) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  filter(x: number, y: number, tMs: number): XY {
    return { x: this.fx.filter(x, tMs), y: this.fy.filter(y, tMs) };
  }

  // Call when the tracked thing disappears, so it is not smoothed from its old position.
  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}

export interface HoldGateOptions {
  // How long the same choice has to be held before it is selected.
  holdMs: number;
  // How long the neutral pose (no choice) has to be seen before a choice counts again.
  armMs?: number;
  // A different or missing reading shorter than this is flicker and does not break a hold.
  graceMs?: number;
  // A pause between two steps longer than this (tab hidden, game paused) clears the gate instead of
  // counting the pause as hold time.
  maxGapMs?: number;
}

export interface HoldGateStep<T> {
  armed: boolean;
  // The choice being held right now, null when nothing is or the gate is not armed.
  choice: T | null;
  // 0..1 of `holdMs`.
  progress: number;
  // Present on the one step where the hold completes. Test it with `!== undefined`, not truthiness:
  // a choice of 0 is a valid selection.
  selected?: T;
}

// "Return to neutral, then hold one choice": the selector the thumb, tilt-free and finger games
// share. Holding is what separates a deliberate answer from a gesture passed through on the way,
// and re-arming on neutral is what stops the previous answer from instantly selecting the next
// question.
export class HoldGate<T> {
  private readonly holdMs: number;
  private readonly armMs: number;
  private readonly graceMs: number;
  private readonly maxGapMs: number;

  private armed = false;
  private neutralSince: number | null = null;
  private candidate: T | null = null;
  private candidateSince = 0;
  private deviating = false;
  private deviantChoice: T | null = null;
  private deviantSince = 0;
  private last: number | null = null;

  constructor({ holdMs, armMs = 200, graceMs = 150, maxGapMs = 1000 }: HoldGateOptions) {
    this.holdMs = holdMs;
    this.armMs = armMs;
    this.graceMs = graceMs;
    this.maxGapMs = maxGapMs;
  }

  step(choice: T | null, now: number): HoldGateStep<T> {
    if (this.last !== null && (now < this.last || now - this.last > this.maxGapMs)) {
      this.lock();
    }
    this.last = now;

    if (!this.armed) {
      if (choice === null) {
        this.neutralSince ??= now;
        if (now - this.neutralSince >= this.armMs) {
          this.armed = true;
        }
      } else {
        this.neutralSince = null;
      }
      return { armed: this.armed, choice: null, progress: 0 };
    }

    if (choice === this.candidate) {
      this.deviating = false;
    } else if (this.candidate === null) {
      // Nothing is being held, so there is no hold to protect: the first reading starts one now.
      this.candidate = choice;
      this.candidateSince = now;
    } else {
      // A different reading while holding: keep the old hold until the new reading has lasted
      // `graceMs`, then switch. The new hold is credited from when the new reading began.
      if (!this.deviating || choice !== this.deviantChoice) {
        this.deviating = true;
        this.deviantChoice = choice;
        this.deviantSince = now;
      }
      if (now - this.deviantSince >= this.graceMs) {
        this.candidate = choice;
        this.candidateSince = this.deviantSince;
        this.deviating = false;
      }
    }

    if (this.candidate === null) {
      return { armed: true, choice: null, progress: 0 };
    }
    const progress = Math.min(1, (now - this.candidateSince) / this.holdMs);
    // Select only while the player is actually still showing the choice, not in the middle of a
    // flicker that happened to land on the last millisecond.
    if (progress >= 1 && choice === this.candidate) {
      const selected = this.candidate;
      this.lock();
      return { armed: false, choice: selected, progress: 1, selected };
    }
    return { armed: true, choice: this.candidate, progress };
  }

  // Back to "not armed" with no hold in progress; the player has to show neutral again. The page
  // calls this on every new question, because it cannot assume the player's hand is already down.
  lock(): void {
    this.armed = false;
    this.neutralSince = null;
    this.candidate = null;
    this.deviating = false;
  }

  // Like `lock`, and also forgets the step timing.
  reset(): void {
    this.lock();
    this.last = null;
  }

  // Skips the neutral pose, for the rare case where it is already known to be neutral.
  arm(): void {
    this.lock();
    this.armed = true;
  }
}

// ---- Head tilt (ported from the head-tilt prototype, same math and thresholds) ---------------

export type HeadControl = 'easy' | 'tilt' | 'move';
export type TiltSide = 'left' | 'right';

// Head roll from the two outer eye corners, in degrees. Landmarks are normalized per axis, so they
// are scaled to pixels first or the angle would be wrong on a non-square image. Positive means the
// top of the (mirrored) head leans toward the screen's left; moving the head without tilting it
// cancels out because only the line between the eyes matters.
export function eyeRoll(a: XY, b: XY, width: number, height: number): number {
  let dx = (b.x - a.x) * width;
  let dy = (b.y - a.y) * height;
  if (dx < 0) {
    dx = -dx;
    dy = -dy;
  }
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

// One number the TiltGate can threshold: the roll, the sideways shift of the head (in eye spans,
// relative to the calibrated neutral) scaled to the same units, or - in 'easy' mode - whichever of
// the two is larger, so a small tilt or a small lean both work.
export function headSignal(
  roll: number,
  centerX: number,
  neutralX: number,
  eyeSpan: number,
  control: HeadControl = 'easy',
  shiftThreshold = 0.4,
  tiltThreshold = 8,
): { signal: number; shift: number; source: 'tilt' | 'move' } {
  const shift = (centerX - neutralX) / Math.max(0.025, eyeSpan);
  const shiftSignal = (shift / shiftThreshold) * tiltThreshold;
  const tiltWins = Math.abs(roll) >= Math.abs(shiftSignal);
  const useRoll = control === 'tilt' || (control === 'easy' && tiltWins);
  const signal = useRoll ? roll : shiftSignal;
  return { signal, shift, source: useRoll ? 'tilt' : 'move' };
}

export interface TiltOptions {
  // Degrees (or the equivalent head shift) needed to choose a side.
  threshold?: number;
  // How long the side has to be held, in ms.
  hold?: number;
}

export interface TiltStep {
  angle?: number;
  progress: number;
  side: TiltSide | null;
  // No usable face this frame (the gate was reset).
  invalid?: boolean;
  // Not armed yet: the head has to come back to the middle first.
  waiting?: boolean;
  selected?: TiltSide;
}

// Left/right selection from a head signal: smooths the signal, arms only after the head has been
// near the middle, then needs the same side held for `hold` ms. The release thresholds are lower
// than the entry ones so a small tremor does not break a hold, but a real return to the middle or
// a switch of side cancels at once.
export class TiltGate {
  private filtered: number | null = null;
  private last: number | null = null;
  private side: TiltSide | null = null;
  private centerSince: number | null = null;
  private armed = false;
  private held = 0;

  reset(): void {
    this.filtered = null;
    this.last = null;
    this.side = null;
    this.centerSince = null;
    this.armed = false;
    this.held = 0;
  }

  cancel(): void {
    this.side = null;
    this.held = 0;
  }

  // Needs the head back in the middle before the next choice, as after answering a question.
  lock(): void {
    this.cancel();
    this.armed = false;
    this.centerSince = null;
  }

  step(
    raw: number,
    faces: number,
    now: number,
    { threshold = 8, hold = 450 }: TiltOptions = {},
  ): TiltStep {
    if (faces !== 1 || !Number.isFinite(raw)) {
      this.reset();
      return { progress: 0, side: null, invalid: true };
    }
    let dt = this.last === null ? 0 : now - this.last;
    if (dt > 1000 || dt < 0) {
      this.reset();
      dt = 0;
    }
    this.last = now;
    const alpha = dt ? 1 - Math.exp(-Math.min(dt, 200) / 65) : 1;
    this.filtered = this.filtered === null ? raw : this.filtered + alpha * (raw - this.filtered);
    const angle = this.filtered;
    const centerLimit = Math.max(4, threshold * 0.55);
    const center = Math.abs(raw) < centerLimit && Math.abs(angle) < centerLimit;
    if (!this.armed) {
      if (center) {
        this.centerSince ??= now;
        if (now - this.centerSince >= 180) {
          this.armed = true;
        }
      } else {
        this.centerSince = null;
      }
      return { angle, progress: 0, side: null, waiting: !this.armed };
    }

    let side: TiltSide | null = null;
    if (this.side === 'left' && angle >= threshold * 0.6 && raw >= threshold * 0.35) {
      side = 'left';
    } else if (this.side === 'right' && angle <= -threshold * 0.6 && raw <= -threshold * 0.35) {
      side = 'right';
    } else if (angle >= threshold && raw >= threshold * 0.8) {
      side = 'left';
    } else if (angle <= -threshold && raw <= -threshold * 0.8) {
      side = 'right';
    }
    if (!side) {
      this.cancel();
      return { angle, progress: 0, side: null };
    }
    if (this.side !== side) {
      this.side = side;
      this.held = 0;
    } else {
      // Capped so a stalled frame cannot count as a long hold.
      this.held += Math.min(dt, 150);
    }
    const progress = Math.min(1, this.held / hold);
    if (progress === 1) {
      this.lock();
      return { angle, progress, side, selected: side };
    }
    return { angle, progress, side };
  }
}

// ---- Hand --------------------------------------------------------------------------------------

// Index, middle, ring, pinky as [tip, PIP] pairs. The thumb is left out on purpose: its bend is
// sideways, so the wrist-distance test below does not work for it.
const FINGERS: ReadonlyArray<readonly [number, number]> = [
  [INDEX_TIP, INDEX_PIP],
  [12, 10],
  [16, 14],
  [20, 18],
];

// How many of the four long fingers are extended. A finger counts when its tip is farther from the
// wrist than its middle joint by `ratio`; measuring from the wrist makes it independent of how the
// hand is rotated, unlike comparing y coordinates.
export function countExtendedFingers(lm: readonly Point3[], aspect = 1, ratio = 1.1): number {
  if (lm.length < 21) {
    return 0;
  }
  let count = 0;
  for (const [tip, pip] of FINGERS) {
    if (dist2d(lm[WRIST], lm[tip], aspect) > ratio * dist2d(lm[WRIST], lm[pip], aspect)) {
      count++;
    }
  }
  return count;
}

// Thumb-to-index gap relative to the hand's size (wrist to middle knuckle), so it does not change
// when the hand moves nearer to or away from the camera. Infinity when the landmarks are unusable.
export function pinchRatio(lm: readonly Point3[], aspect = 1): number {
  if (lm.length < 21) {
    return Number.POSITIVE_INFINITY;
  }
  const size = dist2d(lm[WRIST], lm[MIDDLE_MCP], aspect);
  return size > 0 ? dist2d(lm[THUMB_TIP], lm[INDEX_TIP], aspect) / size : Number.POSITIVE_INFINITY;
}

export interface PinchOptions {
  // Ratio below which the fingers count as pinched, and above which they count as released. The gap
  // between the two (hysteresis) keeps a borderline hand from flickering.
  on?: number;
  off?: number;
  // The new state has to hold this long before it is reported.
  debounceMs?: number;
  // A pinched hand that vanishes stays pinched this long (tracking drops out as the fingers close).
  lostHoldMs?: number;
}

export interface PinchStep {
  pinched: boolean;
  // Set on the one step where the state flips.
  changed: 'down' | 'up' | null;
  ratio: number;
}

// Turns the pinch ratio into press/release events with hysteresis and debounce.
export class PinchDetector {
  private readonly on: number;
  private readonly off: number;
  private readonly debounceMs: number;
  private readonly lostHoldMs: number;
  private pinched = false;
  private pendingSince: number | null = null;
  private lostSince: number | null = null;
  private lastRatio = Number.POSITIVE_INFINITY;

  constructor({ on = 0.25, off = 0.4, debounceMs = 80, lostHoldMs = 300 }: PinchOptions = {}) {
    this.on = on;
    this.off = off;
    this.debounceMs = debounceMs;
    this.lostHoldMs = lostHoldMs;
  }

  step(lm: readonly Point3[] | null, now: number, aspect = 1): PinchStep {
    if (!lm) {
      this.pendingSince = null;
      if (!this.pinched) {
        return { pinched: false, changed: null, ratio: Number.POSITIVE_INFINITY };
      }
      this.lostSince ??= now;
      if (now - this.lostSince >= this.lostHoldMs) {
        this.pinched = false;
        this.lostSince = null;
        return { pinched: false, changed: 'up', ratio: Number.POSITIVE_INFINITY };
      }
      return { pinched: true, changed: null, ratio: this.lastRatio };
    }

    this.lostSince = null;
    const ratio = pinchRatio(lm, aspect);
    this.lastRatio = ratio;
    const flips = this.pinched ? ratio > this.off : ratio < this.on;
    if (!flips) {
      this.pendingSince = null;
      return { pinched: this.pinched, changed: null, ratio };
    }
    this.pendingSince ??= now;
    if (now - this.pendingSince < this.debounceMs) {
      return { pinched: this.pinched, changed: null, ratio };
    }
    this.pinched = !this.pinched;
    this.pendingSince = null;
    return { pinched: this.pinched, changed: this.pinched ? 'down' : 'up', ratio };
  }

  reset(): void {
    this.pinched = false;
    this.pendingSince = null;
    this.lostSince = null;
    this.lastRatio = Number.POSITIVE_INFINITY;
  }
}

// ---- Face --------------------------------------------------------------------------------------

export interface BiteOptions {
  // jawOpen blendshape score at or above which the mouth counts as open, and at or below which it
  // counts as closed again (hysteresis).
  open?: number;
  close?: number;
  // The mouth must have been open this long, so a twitch is not a bite.
  minOpenMs?: number;
}

export interface BiteStep {
  open: boolean;
  // True on exactly one step: the mouth closing after having been open long enough.
  bite: boolean;
}

// A bite is the whole open-then-close, not just the open: the frog game rewards snapping the mouth
// shut. Call `reset` when the face is lost so a half-finished bite does not complete by itself.
export class BiteDetector {
  private readonly open: number;
  private readonly close: number;
  private readonly minOpenMs: number;
  private isOpen = false;
  private openSince = 0;

  constructor({ open = 0.45, close = 0.2, minOpenMs = 80 }: BiteOptions = {}) {
    this.open = open;
    this.close = close;
    this.minOpenMs = minOpenMs;
  }

  step(jawOpen: number, now: number): BiteStep {
    let bite = false;
    if (!this.isOpen && jawOpen >= this.open) {
      this.isOpen = true;
      this.openSince = now;
    } else if (this.isOpen && jawOpen <= this.close) {
      this.isOpen = false;
      bite = now - this.openSince >= this.minOpenMs;
    }
    return { open: this.isOpen, bite };
  }

  reset(): void {
    this.isOpen = false;
  }
}

// The true/false game's choice: thumb up is the first option (Đúng), thumb down the second (Sai).
// MediaPipe's gesture score has to clear `minScore` so a half-recognized hand does not answer.
export function thumbChoice(frame: HandFrame, minScore = 0.6): 0 | 1 | null {
  if (frame.gestureScore < minScore) {
    return null;
  }
  if (frame.gesture === 'Thumb_Up') {
    return 0;
  }
  if (frame.gesture === 'Thumb_Down') {
    return 1;
  }
  return null;
}

// Does the segment a->b pass within `r` of the point c? Returns where along the segment (t, 0..1)
// and how close (d) it came. Testing the whole segment, not just the end point, is what lets a fast
// swipe that jumps over a small target between two frames still hit it.
export function segHit(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  r: number,
): { t: number; d: number } | null {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-6) {
    return null;
  }
  const t = clamp(((cx - ax) * dx + (cy - ay) * dy) / lengthSquared, 0, 1);
  const d = Math.hypot(cx - (ax + t * dx), cy - (ay + t * dy));
  return d <= r ? { t, d } : null;
}
