import type { FaceFrame, Point3 } from '../../../../game/stage-game';
import type { FacePose } from './face-common';

// Synthetic FaceFrames for the face games' specs. Not imported by any app code, so it never reaches
// the bundle; it lives next to the code it tests because both games' specs share it.

export const VIDEO_WIDTH = 640;
export const VIDEO_HEIGHT = 480;

export interface FaceSpec {
  // Head roll in degrees as `eyeRoll` reports it: positive means the eye on the image's right is
  // lower, i.e. the player leans toward the screen's left in the mirrored preview.
  roll?: number;
  // Eye centre and nose tip x, normalized and unmirrored (the player's right is the image's left).
  centerX?: number;
  noseX?: number;
  span?: number;
  jawOpen?: number;
  // 0 gives a frame with nothing in view, 2 or more a crowded one.
  faces?: number;
}

export const NEUTRAL: FacePose = {
  roll: 0,
  centerX: 0.5,
  noseX: 0.5,
  eyeSpan: 0.2
};

export function faceFrame({
                            roll = 0,
                            centerX = 0.5,
                            noseX = centerX,
                            span = 0.2,
                            jawOpen = 0,
                            faces = 1,
                          }: FaceSpec = {}): FaceFrame {
  if (faces === 0) {
    return {
      faces: 0,
      landmarks: null,
      blendshapes: {}
    };
  }
  const landmarks: Point3[] = Array.from({ length: 478 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0
  }));
  // The vertical gap between the eyes that makes a roll of `roll` degrees on this camera image.
  const dy = (Math.tan((roll * Math.PI) / 180) * span * VIDEO_WIDTH) / VIDEO_HEIGHT;
  landmarks[33] = {
    x: centerX - span / 2,
    y: 0.4 - dy / 2,
    z: 0
  };
  landmarks[263] = {
    x: centerX + span / 2,
    y: 0.4 + dy / 2,
    z: 0
  };
  landmarks[1] = {
    x: noseX,
    y: 0.5,
    z: 0
  };
  return {
    faces,
    landmarks,
    blendshapes: { jawOpen }
  };
}

// Feeds `step` one frame every `stepMs` from `from` for `durationMs`, returning every result and the
// time of the last frame, so a spec can chain phases ("neutral for 400 ms, then tilted for 700 ms").
export function playFrames<T>(
  step: (now: number) => T,
  from: number,
  durationMs: number,
  stepMs = 33,
): { results: T[]; end: number } {
  const results: T[] = [];
  let now = from;
  for (; now <= from + durationMs; now += stepMs) {
    results.push(step(now));
  }
  return {
    results,
    end: now
  };
}
