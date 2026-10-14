import type { FacePose } from '../head-tilt-game/face-common';
import {
  NEUTRAL,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  faceFrame,
  playFrames,
} from '../head-tilt-game/face-fixture';
import type { FaceSpec } from '../head-tilt-game/face-fixture';
import {
  FrogReader,
  FrogStep,
  LANE_ENTER_SPANS,
  LANE_LEAVE_SPANS,
  LANE_STABLE_MS,
  LaneTracker,
  frogHint,
  nextLane,
  screenShift,
} from './frog-logic';

// Nose x for a head `spans` eye spans toward the screen's right of the neutral one. The camera image
// is unmirrored, so moving right on the (mirrored) screen means a smaller x in the image.
function noseAt(spans: number, neutral: FacePose = NEUTRAL): number {
  return neutral.noseX - spans * neutral.eyeSpan;
}

function play(reader: FrogReader, spec: FaceSpec, from: number, durationMs: number) {
  return playFrames(
    now => reader.step(faceFrame(spec), VIDEO_WIDTH, VIDEO_HEIGHT, NEUTRAL, now),
    from,
    durationMs,
  );
}

// One bite at `noseX`: the mouth open for 150 ms, then closed again.
function bite(reader: FrogReader, noseX: number, from: number) {
  const open = play(reader, { noseX, centerX: noseX, jawOpen: 0.7 }, from, 150);
  const closed = play(reader, { noseX, centerX: noseX, jawOpen: 0.05 }, open.end, 100);
  return { results: [...open.results, ...closed.results], end: closed.end };
}

function selections(steps: FrogStep[]): number[] {
  return steps.flatMap(step => (step.selected === null ? [] : [step.selected]));
}

describe('screen-space head shift', () => {
  it('is positive when the player moves to the right of the mirrored screen', () => {
    // The player's right is the image's left: a smaller x.
    expect(screenShift(0.4, 0.5, 0.2)).toBeCloseTo(0.5, 6);
    expect(screenShift(0.6, 0.5, 0.2)).toBeCloseTo(-0.5, 6);
    expect(screenShift(0.5, 0.5, 0.2)).toBeCloseTo(0, 6);
  });

  it('measures in eye spans, with a floor for a degenerate span', () => {
    expect(screenShift(0.45, 0.5, 0.1)).toBeCloseTo(0.5, 6);
    expect(Number.isFinite(screenShift(0.4, 0.5, 0))).toBeTrue();
  });
});

describe('nextLane', () => {
  it('steps into a side lane at the enter threshold', () => {
    expect(nextLane(1, LANE_ENTER_SPANS - 0.01)).toBe(1);
    expect(nextLane(1, LANE_ENTER_SPANS)).toBe(2);
    expect(nextLane(1, -(LANE_ENTER_SPANS - 0.01))).toBe(1);
    expect(nextLane(1, -LANE_ENTER_SPANS)).toBe(0);
  });

  it('stays in a side lane until the head is back below the smaller leave threshold', () => {
    expect(nextLane(2, LANE_LEAVE_SPANS + 0.01)).toBe(2);
    expect(nextLane(2, LANE_LEAVE_SPANS - 0.01)).toBe(1);
    expect(nextLane(0, -(LANE_LEAVE_SPANS + 0.01))).toBe(0);
    expect(nextLane(0, -(LANE_LEAVE_SPANS - 0.01))).toBe(1);
  });

  it('does not flicker for a head resting between the two thresholds', () => {
    const between = (LANE_ENTER_SPANS + LANE_LEAVE_SPANS) / 2;
    // From the middle it stays in the middle, from the side lane it stays there.
    expect(nextLane(1, between)).toBe(1);
    expect(nextLane(2, between)).toBe(2);
    expect(nextLane(1, -between)).toBe(1);
    expect(nextLane(0, -between)).toBe(0);
  });

  it('can cross from one side lane to the other in one jump', () => {
    expect(nextLane(0, 0.8)).toBe(2);
    expect(nextLane(2, -0.8)).toBe(0);
  });
});

describe('LaneTracker', () => {
  it('counts how long the frog has been in its lane and starts over when it moves', () => {
    const tracker = new LaneTracker();
    expect(tracker.update(0, 1000)).toEqual({ lane: 1, changed: false, stableMs: 0 });
    expect(tracker.update(0.1, 1250).stableMs).toBe(250);

    const moved = tracker.update(0.7, 1300);
    expect(moved).toEqual({ lane: 2, changed: true, stableMs: 0 });
    expect(tracker.update(0.6, 1700)).toEqual({ lane: 2, changed: false, stableMs: 400 });
  });

  it('goes back to the middle lane when reset', () => {
    const tracker = new LaneTracker();
    tracker.update(0.7, 0);
    tracker.reset();
    expect(tracker.update(0, 500)).toEqual({ lane: 1, changed: false, stableMs: 0 });
  });
});

describe('FrogReader', () => {
  it('follows the head: right on the screen is the third lane, left the first', () => {
    const reader = new FrogReader();
    const right = play(reader, { noseX: noseAt(0.75), centerX: noseAt(0.75) }, 0, 200);
    expect(right.results[right.results.length - 1].lane).toBe(2);

    const left = play(reader, { noseX: noseAt(-0.75), centerX: noseAt(-0.75) }, right.end, 200);
    expect(left.results[left.results.length - 1].lane).toBe(0);
  });

  it('bites option 2 after resting on the right lane and snapping the mouth shut', () => {
    const reader = new FrogReader();
    const rest = play(reader, { noseX: noseAt(0.75), jawOpen: 0.05 }, 0, 400);
    const snap = bite(reader, noseAt(0.75), rest.end);

    expect(selections(rest.results)).toEqual([]);
    expect(selections(snap.results)).toEqual([2]);
  });

  it('bites the first lane on the left and the middle one at rest', () => {
    const left = new FrogReader();
    const leftRest = play(left, { noseX: noseAt(-0.75), jawOpen: 0.05 }, 0, 400);
    expect(selections(bite(left, noseAt(-0.75), leftRest.end).results)).toEqual([0]);

    const middle = new FrogReader();
    const middleRest = play(middle, { jawOpen: 0.05 }, 0, 400);
    expect(selections(bite(middle, NEUTRAL.noseX, middleRest.end).results)).toEqual([1]);
  });

  it('only counts a bite once the lane has been stable for 300 ms', () => {
    const reader = new FrogReader();
    play(reader, { jawOpen: 0.05 }, 0, 400);
    // The frog hops to the right lane and the bite finishes after about 165 ms: too soon.
    const quick = bite(reader, noseAt(0.75), 450);
    expect(selections(quick.results)).toEqual([]);
    expect(quick.results.some(step => step.missed)).toBeTrue();
  });

  it('counts a bite once the lane is stable, also if the mouth opened while it was not', () => {
    const reader = new FrogReader();
    play(reader, { jawOpen: 0.05 }, 0, 400);
    // Open the mouth on arrival, keep it open past LANE_STABLE_MS, then close.
    const open = play(reader, { noseX: noseAt(0.75), jawOpen: 0.7 }, 450, LANE_STABLE_MS + 100);
    const closed = play(reader, { noseX: noseAt(0.75), jawOpen: 0.05 }, open.end, 100);
    expect(selections(closed.results)).toEqual([2]);
  });

  it('does not count a twitch of the mouth', () => {
    const reader = new FrogReader();
    const rest = play(reader, { jawOpen: 0.05 }, 0, 400);
    const open = play(reader, { jawOpen: 0.7 }, rest.end, 0);
    const closed = play(reader, { jawOpen: 0.05 }, open.end, 100);
    expect(selections([...open.results, ...closed.results])).toEqual([]);
  });

  it('bites once: the mouth must be closed and a new question started before the next bite', () => {
    const reader = new FrogReader();
    const rest = play(reader, { jawOpen: 0.05 }, 0, 400);
    const first = bite(reader, NEUTRAL.noseX, rest.end);
    expect(selections(first.results)).toEqual([1]);

    const second = bite(reader, NEUTRAL.noseX, first.end);
    expect(selections(second.results)).toEqual([]);

    reader.newQuestion();
    const settle = play(reader, { jawOpen: 0.05 }, second.end, 100);
    const third = bite(reader, NEUTRAL.noseX, settle.end);
    expect(selections(third.results)).toEqual([1]);
  });

  it('does not let a mouth still open at the start of a question bite when it closes', () => {
    const reader = new FrogReader();
    play(reader, { jawOpen: 0.05 }, 0, 400);
    reader.newQuestion();

    const stillOpen = play(reader, { jawOpen: 0.7 }, 450, 500);
    const closes = play(reader, { jawOpen: 0.05 }, stillOpen.end, 200);
    expect(selections([...stillOpen.results, ...closes.results])).toEqual([]);
    expect(stillOpen.results[0].waitingForClosedMouth).toBeTrue();

    // Seen closed now: a real bite works again.
    const snap = bite(reader, NEUTRAL.noseX, closes.end);
    expect(selections(snap.results)).toEqual([1]);
  });

  it('selects nothing and reports why while the face count is not one', () => {
    const reader = new FrogReader();
    const rest = play(reader, { noseX: noseAt(0.75), jawOpen: 0.05 }, 0, 400);

    const crowd = play(reader, { noseX: noseAt(0.75), jawOpen: 0.7, faces: 2 }, rest.end, 300);
    const closed = play(reader, { noseX: noseAt(0.75), jawOpen: 0.05, faces: 2 }, crowd.end, 200);
    expect(selections([...crowd.results, ...closed.results])).toEqual([]);
    expect(crowd.results.every(step => step.invalid)).toBeTrue();
    expect(crowd.results[0].problem).toBe('Chỉ một người trước camera');
    expect(crowd.results[0].lane).toBe(1);

    const none = play(reader, { faces: 0 }, closed.end, 100);
    expect(none.results[0].problem).toBe('Chưa thấy mặt · đến gần và nhìn camera');
  });

  it('does not finish a bite that was in progress when the face was lost', () => {
    const reader = new FrogReader();
    const rest = play(reader, { jawOpen: 0.05 }, 0, 400);
    const open = play(reader, { jawOpen: 0.7 }, rest.end, 200);
    const lost = play(reader, { faces: 0 }, open.end, 100);
    // The face is back with the mouth closed, and the lane has to be held again.
    const back = play(reader, { jawOpen: 0.05 }, lost.end, 600);
    expect(selections(back.results)).toEqual([]);
  });

  it('keeps a lane for a head resting between the enter and leave thresholds', () => {
    const reader = new FrogReader();
    play(reader, { noseX: noseAt(0.75) }, 0, 300);
    const between = (LANE_ENTER_SPANS + LANE_LEAVE_SPANS) / 2;
    const resting = play(reader, { noseX: noseAt(between) }, 400, 1000);
    expect(resting.results.every(step => step.lane === 2 && !step.laneChanged)).toBeTrue();
  });

  it('reports lane changes once, for the sound', () => {
    const reader = new FrogReader();
    const run = play(reader, { noseX: noseAt(0.75) }, 0, 400);
    expect(run.results.filter(step => step.laneChanged).length).toBe(1);
  });

  it('reads a missing jawOpen blendshape as a closed mouth', () => {
    const reader = new FrogReader();
    const frame = { ...faceFrame(), blendshapes: {} };
    const step = reader.step(frame, VIDEO_WIDTH, VIDEO_HEIGHT, NEUTRAL, 0);
    expect(step.jawOpen).toBe(0);
    expect(step.invalid).toBeFalse();
  });
});

describe('frogHint', () => {
  const base: FrogStep = {
    invalid: false,
    problem: null,
    lane: 1,
    laneChanged: false,
    shift: 0,
    stable: true,
    jawOpen: 0,
    mouthOpen: false,
    waitingForClosedMouth: false,
    bite: false,
    missed: false,
    selected: null,
  };

  it('says what to do next', () => {
    expect(frogHint({ ...base, problem: 'Chưa thấy mặt', invalid: true })).toBe('Chưa thấy mặt');
    expect(frogHint({ ...base, mouthOpen: true })).toBe('Khép miệng lại để đớp!');
    expect(frogHint({ ...base, waitingForClosedMouth: true })).toBe('Ngậm miệng lại một chút');
    expect(frogHint({ ...base, stable: false })).toBe('Dịch đầu sang làn đáp án');
    expect(frogHint({ ...base, lane: 2 })).toBe('Há miệng to rồi khép lại để đớp');
    expect(frogHint(base)).toContain('Dịch đầu sang làn đáp án');
    expect(frogHint(base)).toContain('há miệng');
  });
});
