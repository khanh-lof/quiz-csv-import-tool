import { BiteDetector } from '../../../../game/gestures';
import type { FaceFrame } from '../../../../game/stage-game';
import type { FacePose } from '../head-tilt-game/face-common';
import { faceProblemMessage, readFacePose } from '../head-tilt-game/face-common';

// The frog sits in one of three lanes, left to right on the screen; a lane's index is also the index
// of its option.
export type Lane = 0 | 1 | 2;

// Head shift, in eye spans from the calibrated neutral, needed to step into a side lane, and the
// smaller shift below which the frog steps back toward the middle. The gap between the two
// (hysteresis) keeps a head resting on a boundary from making the frog flicker between lanes.
export const LANE_ENTER_SPANS = 0.5;
export const LANE_LEAVE_SPANS = 0.35;

// The frog must have stayed in its lane this long before a bite counts, so a bite that finishes
// while the head is still on the move does not snap at the lane it only passed through.
export const LANE_STABLE_MS = 300;

// Mouth thresholds for the bite (jawOpen blendshape): opens at 0.45, counts as closed at 0.2.
export const BITE_OPEN = 0.45;
export const BITE_CLOSE = 0.2;

// Eye spans below this are noise (the same floor `headSignal` uses).
const MIN_EYE_SPAN = 0.025;

// How far the head is from its neutral place, in eye spans, in SCREEN space: positive is toward the
// screen's right. MediaPipe reports the unmirrored camera image, where the player's right is at
// smaller x, but the preview the player watches is mirrored (a mirror), so the player moving to
// their right moves their image to the screen's right. The sign is therefore flipped: a nose x
// smaller than the neutral one is a positive (rightward) shift.
export function screenShift(noseX: number, neutralNoseX: number, eyeSpan: number): number {
  return -(noseX - neutralNoseX) / Math.max(MIN_EYE_SPAN, eyeSpan);
}

// The lane after a head shift (in screen space, see `screenShift`), given the lane the frog is in.
// A side lane is entered at ±LANE_ENTER_SPANS but only left again below ±LANE_LEAVE_SPANS.
export function nextLane(current: Lane, shift: number): Lane {
  if (current === 0 && shift <= -LANE_LEAVE_SPANS) {
    return 0;
  }
  if (current === 2 && shift >= LANE_LEAVE_SPANS) {
    return 2;
  }
  if (shift <= -LANE_ENTER_SPANS) {
    return 0;
  }
  if (shift >= LANE_ENTER_SPANS) {
    return 2;
  }
  return 1;
}

export interface LaneStep {
  lane: Lane;
  changed: boolean;
  // How long the frog has been in this lane.
  stableMs: number;
}

// Follows the head with hysteresis and remembers since when the frog has been in its lane.
export class LaneTracker {
  private lane: Lane = 1;
  private since: number | null = null;

  update(shift: number, now: number): LaneStep {
    const next = nextLane(this.lane, shift);
    const changed = next !== this.lane;
    if (changed || this.since === null) {
      this.lane = next;
      this.since = now;
    }
    return {
      lane: this.lane,
      changed,
      stableMs: now - this.since
    };
  }

  // Back to the middle lane with nothing remembered, for when the head is lost.
  reset(): void {
    this.lane = 1;
    this.since = null;
  }
}

export interface FrogStep {
  // No single usable face this frame; `problem` says why in words.
  invalid: boolean;
  problem: string | null;
  lane: Lane;
  laneChanged: boolean;
  // Head shift in screen space, in eye spans (positive = toward the right lane).
  shift: number;
  // The lane has been the same for LANE_STABLE_MS.
  stable: boolean;
  jawOpen: number;
  mouthOpen: boolean;
  // A new question or a lost face: the mouth has to be seen closed before a bite counts.
  waitingForClosedMouth: boolean;
  // A bite finished on this step, whether or not it counted.
  bite: boolean;
  // The bite finished while the lane was not stable, so it did not count.
  missed: boolean;
  // The lane (= option index) the frog bit on this one step, else null.
  selected: Lane | null;
}

// A face frame in, a lane and its bites out: the nose position picks the lane, the open-then-close
// of the jaw is the bite, and a bite only counts in a lane the frog has held for a moment.
export class FrogReader {
  private readonly lanes = new LaneTracker();
  private readonly bites = new BiteDetector({
    open: BITE_OPEN,
    close: BITE_CLOSE
  });
  private waitingForClosedMouth = true;
  // A bite has answered this question; only `newQuestion` allows another.
  private answered = false;

  step(face: FaceFrame, videoW: number, videoH: number, neutral: FacePose, now: number): FrogStep {
    const pose = readFacePose(face, videoW, videoH);
    if (!pose) {
      // A bite half done when the face is lost must not complete by itself when it comes back.
      this.lanes.reset();
      this.bites.reset();
      this.waitingForClosedMouth = true;
      return {
        invalid: true,
        problem: faceProblemMessage(face.faces) ?? faceProblemMessage(0),
        lane: 1,
        laneChanged: false,
        shift: 0,
        stable: false,
        jawOpen: 0,
        mouthOpen: false,
        waitingForClosedMouth: true,
        bite: false,
        missed: false,
        selected: null,
      };
    }

    const shift = screenShift(pose.noseX, neutral.noseX, pose.eyeSpan);
    const lane = this.lanes.update(shift, now);
    const stable = lane.stableMs >= LANE_STABLE_MS;

    const jawOpen = face.blendshapes['jawOpen'] ?? 0;
    let bite = false;
    let mouthOpen = false;
    if (this.waitingForClosedMouth) {
      if (jawOpen <= BITE_CLOSE && !this.answered) {
        this.waitingForClosedMouth = false;
        this.bites.reset();
      }
    } else {
      const result = this.bites.step(jawOpen, now);
      bite = result.bite;
      mouthOpen = result.open;
    }

    const selected = bite && stable ? lane.lane : null;
    if (selected !== null) {
      // One bite answers one question: the next one needs a fresh `newQuestion`.
      this.answered = true;
      this.waitingForClosedMouth = true;
    }
    return {
      invalid: false,
      problem: null,
      lane: lane.lane,
      laneChanged: lane.changed,
      shift,
      stable,
      jawOpen,
      mouthOpen,
      waitingForClosedMouth: this.waitingForClosedMouth,
      bite,
      missed: bite && !stable,
      selected,
    };
  }

  // A fresh question: the mouth must have been seen closed again before a bite counts, so a mouth
  // still open from the last answer (or from a yawn) never answers the next question.
  newQuestion(): void {
    this.bites.reset();
    this.answered = false;
    this.waitingForClosedMouth = true;
  }

  reset(): void {
    this.lanes.reset();
    this.newQuestion();
  }
}

// What the hint under the mouth meter says.
export function frogHint(step: FrogStep): string {
  if (step.problem) {
    return step.problem;
  }
  if (step.mouthOpen) {
    return 'Khép miệng lại để đớp!';
  }
  if (step.waitingForClosedMouth) {
    return 'Ngậm miệng lại một chút';
  }
  if (!step.stable) {
    return 'Dịch đầu sang làn đáp án';
  }
  // In the middle lane the player has most likely not chosen yet, so both steps are spelled out.
  return step.lane === 1
    ? 'Dịch đầu sang làn đáp án · há rồi khép miệng để đớp'
    : 'Há rồi khép miệng để đớp';
}
