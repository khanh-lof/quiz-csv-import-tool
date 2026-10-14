import {
  FACE_LEFT_EYE_OUTER,
  FACE_NOSE_TIP,
  FACE_RIGHT_EYE_OUTER,
  eyeRoll,
} from '../../../../game/gestures';
import type { FaceFrame } from '../../../../game/stage-game';

// What the two face games (head tilt, frog) share: reading the head pose from a FaceFrame, the
// one-second calibration of the player's neutral pose (ported from the head-tilt prototype) and the
// small text helpers around them. Everything here is pure so it can be tested with synthetic frames.

// How long the player has to look steadily at the camera, and how much the head may move during that
// time before the second starts over: 6 degrees of roll, or a quarter of an eye span sideways.
export const CALIBRATION_MS = 1000;
export const MAX_ROLL_DRIFT_DEG = 6;
export const MAX_CENTER_DRIFT_SPANS = 0.25;

// A pause between two frames longer than this (the game was paused, the tab hidden) is not steady
// looking, so it clears the samples instead of counting as calibration time.
const MAX_GAP_MS = 500;

// A 4:3 webcam, assumed while the real camera size is not known yet (0x0), so the roll is still sane.
const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 480;

// The pose of one face, in the camera's own (unmirrored) image coordinates.
export interface FacePose {
  // Head roll in degrees, as `eyeRoll` reports it.
  roll: number;
  // Eye centre and nose tip x, normalized 0..1.
  centerX: number;
  noseX: number;
  // Distance between the outer eye corners in x, normalized: the ruler head shifts are measured in.
  eyeSpan: number;
}

// The pose of the single face in the frame, or null when there is not exactly one usable face.
export function readFacePose(face: FaceFrame, videoW: number, videoH: number): FacePose | null {
  const lm = face.landmarks;
  if (face.faces !== 1 || !lm || lm.length <= FACE_RIGHT_EYE_OUTER) {
    return null;
  }
  const known = videoW > 0 && videoH > 0;
  const width = known ? videoW : FALLBACK_WIDTH;
  const height = known ? videoH : FALLBACK_HEIGHT;
  const a = lm[FACE_LEFT_EYE_OUTER];
  const b = lm[FACE_RIGHT_EYE_OUTER];
  return {
    roll: eyeRoll(a, b, width, height),
    centerX: (a.x + b.x) / 2,
    noseX: lm[FACE_NOSE_TIP].x,
    eyeSpan: Math.abs(a.x - b.x),
  };
}

export type CalibrationStatus = 'no-face' | 'many-faces' | 'collecting' | 'done';

export interface CalibrationStep {
  status: CalibrationStatus;
  // 0..1 of CALIBRATION_MS of steady looking.
  progress: number;
  // Only on the step where the calibration completes: the mean pose of the steady second.
  neutral?: FacePose;
}

// Collects about a second of steady samples. It restarts when the head drifts or the face is lost,
// and pauses (progress 0) while the number of faces is not exactly one, so a bystander cannot
// calibrate the game against the wrong head.
export class FaceCalibrator {
  private samples: FacePose[] = [];
  private since = 0;
  private last: number | null = null;

  step(face: FaceFrame, videoW: number, videoH: number, now: number): CalibrationStep {
    const gap = this.last === null ? 0 : now - this.last;
    this.last = now;
    if (gap > MAX_GAP_MS || gap < 0) {
      this.samples = [];
    }

    const pose = readFacePose(face, videoW, videoH);
    if (!pose) {
      this.samples = [];
      return { status: face.faces > 1 ? 'many-faces' : 'no-face', progress: 0 };
    }

    if (this.samples.length > 0 && this.drifted(pose)) {
      this.samples = [];
    }
    if (this.samples.length === 0) {
      this.since = now;
    }
    this.samples.push(pose);

    const elapsed = now - this.since;
    if (elapsed >= CALIBRATION_MS) {
      const neutral = FaceCalibrator.mean(this.samples);
      this.reset();
      return { status: 'done', progress: 1, neutral };
    }
    return { status: 'collecting', progress: elapsed / CALIBRATION_MS };
  }

  reset(): void {
    this.samples = [];
    this.last = null;
  }

  // Compared with the mean of the samples so far, not with the previous frame, so a slow drift adds
  // up and restarts the second just like a sudden move.
  private drifted(pose: FacePose): boolean {
    const mean = FaceCalibrator.mean(this.samples);
    return (
      Math.abs(pose.roll - mean.roll) > MAX_ROLL_DRIFT_DEG ||
      Math.abs(pose.centerX - mean.centerX) > pose.eyeSpan * MAX_CENTER_DRIFT_SPANS
    );
  }

  private static mean(samples: readonly FacePose[]): FacePose {
    const n = samples.length;
    const sum = samples.reduce(
      (total, s) => ({
        roll: total.roll + s.roll,
        centerX: total.centerX + s.centerX,
        noseX: total.noseX + s.noseX,
        eyeSpan: total.eyeSpan + s.eyeSpan,
      }),
      { roll: 0, centerX: 0, noseX: 0, eyeSpan: 0 },
    );
    return {
      roll: sum.roll / n,
      centerX: sum.centerX / n,
      noseX: sum.noseX / n,
      eyeSpan: sum.eyeSpan / n,
    };
  }
}

// Why the face cannot be used right now, or null when exactly one face is in view.
export function faceProblemMessage(faces: number): string | null {
  if (faces === 1) {
    return null;
  }
  return faces > 1 ? 'Chỉ một người trước camera' : 'Chưa thấy mặt · đến gần và nhìn camera';
}

export function calibrationMessage(status: CalibrationStatus, progress: number): string {
  if (status === 'no-face') {
    return faceProblemMessage(0) ?? '';
  }
  if (status === 'many-faces') {
    return faceProblemMessage(2) ?? '';
  }
  const seconds = (Math.min(1, Math.max(0, progress)) * CALIBRATION_MS) / 1000;
  return `Nhìn thẳng vào camera · ${seconds.toFixed(1)} / 1 giây`;
}

// A card's text split into the word and the note in brackets after it, e.g. '水 (shuǐ)' into '水' and
// 'shuǐ', so the game can show the hanzi large and the pinyin small. Text without a trailing bracket
// stays whole.
export function splitOption(text: string): { main: string; note: string } {
  const match = /^(.*\S)\s*\(([^()]*)\)\s*$/.exec(text);
  return match ? { main: match[1], note: match[2].trim() } : { main: text, note: '' };
}

// 'big' for a short word, shrinking for longer ones, so a card never overflows.
export function wordSize(main: string): 'big' | 'mid' | 'small' {
  const length = [...main].length;
  return length <= 3 ? 'big' : length <= 5 ? 'mid' : 'small';
}

// The game's answer keys must not fire while the player types somewhere.
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') {
    return false;
  }
  const tag = element.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  return typing || element.isContentEditable === true;
}
