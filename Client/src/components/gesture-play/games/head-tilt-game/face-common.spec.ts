import type { CalibrationStep } from './face-common';
import {
  CALIBRATION_MS,
  calibrationMessage,
  FaceCalibrator,
  faceProblemMessage,
  isTypingTarget,
  readFacePose,
  splitOption,
  wordSize,
} from './face-common';
import { faceFrame, playFrames, VIDEO_HEIGHT, VIDEO_WIDTH } from './face-fixture';

describe('readFacePose', () => {
  it('reads roll, eye centre, nose and span of the single face', () => {
    const pose = readFacePose(
      faceFrame({
        roll: 10,
        centerX: 0.4,
        noseX: 0.45,
        span: 0.18
      }),
      VIDEO_WIDTH,
      VIDEO_HEIGHT,
    );
    expect(pose).not.toBeNull();
    expect(pose!.roll).toBeCloseTo(10, 5);
    expect(pose!.centerX).toBeCloseTo(0.4, 6);
    expect(pose!.noseX).toBeCloseTo(0.45, 6);
    expect(pose!.eyeSpan).toBeCloseTo(0.18, 6);
  });

  it('reads a lower eye on the image right as a positive roll, on the left as negative', () => {
    const roll = (degrees: number) =>
      readFacePose(faceFrame({ roll: degrees }), VIDEO_WIDTH, VIDEO_HEIGHT)!.roll;
    expect(roll(7)).toBeGreaterThan(0);
    expect(roll(-7)).toBeLessThan(0);
  });

  it('is null unless exactly one face is in view', () => {
    expect(readFacePose(faceFrame({ faces: 0 }), VIDEO_WIDTH, VIDEO_HEIGHT)).toBeNull();
    expect(readFacePose(faceFrame({ faces: 2 }), VIDEO_WIDTH, VIDEO_HEIGHT)).toBeNull();
    expect(
      readFacePose({
        faces: 1,
        landmarks: [],
        blendshapes: {}
      }, VIDEO_WIDTH, VIDEO_HEIGHT),
    ).toBeNull();
  });

  it('assumes a 4:3 camera while the video size is still unknown', () => {
    const pose = readFacePose(faceFrame({ roll: 10 }), 0, 0);
    expect(pose!.roll).toBeCloseTo(10, 5);
  });
});

describe('FaceCalibrator', () => {
  function feed(
    calibrator: FaceCalibrator,
    spec: Parameters<typeof faceFrame>[0],
    from: number,
    durationMs: number,
  ) {
    return playFrames(
      now => calibrator.step(faceFrame(spec), VIDEO_WIDTH, VIDEO_HEIGHT, now),
      from,
      durationMs,
    );
  }

  it('finishes after about a second of steady looking and reports the mean pose', () => {
    const calibrator = new FaceCalibrator();
    const { results } = feed(calibrator, {
      roll: 3,
      centerX: 0.52,
      noseX: 0.53
    }, 0, 1100);
    const done = results.find(step => step.status === 'done');

    expect(done).toBeDefined();
    expect(done!.neutral!.roll).toBeCloseTo(3, 4);
    expect(done!.neutral!.centerX).toBeCloseTo(0.52, 6);
    expect(done!.neutral!.noseX).toBeCloseTo(0.53, 6);
    expect(done!.neutral!.eyeSpan).toBeCloseTo(0.2, 6);
    // Not a frame earlier than the second is full.
    expect(results.findIndex(step => step.status === 'done')).toBeGreaterThanOrEqual(
      Math.floor(CALIBRATION_MS / 33),
    );
  });

  it('reports the progress of the second while collecting', () => {
    const calibrator = new FaceCalibrator();
    const { results } = feed(calibrator, {}, 0, 500);
    const last = results[results.length - 1];
    expect(last.status).toBe('collecting');
    expect(last.progress).toBeGreaterThan(0.4);
    expect(last.progress).toBeLessThan(0.6);
    expect(results[0].progress).toBe(0);
  });

  it('starts the second again when the roll drifts by more than 6 degrees', () => {
    const calibrator = new FaceCalibrator();
    const first = feed(calibrator, { roll: 0 }, 0, 600);
    const moved = feed(calibrator, { roll: 9 }, first.end, 0);
    expect(moved.results[0].status).toBe('collecting');
    expect(moved.results[0].progress).toBe(0);
    // And it needs a whole new second from there.
    const rest = feed(calibrator, { roll: 9 }, moved.end, 700);
    expect(rest.results.some(step => step.status === 'done')).toBeFalse();
  });

  it('does not restart for a small wobble', () => {
    const calibrator = new FaceCalibrator();
    const first = feed(calibrator, {
      roll: 0,
      centerX: 0.5
    }, 0, 600);
    const wobble = feed(calibrator, {
      roll: 4,
      centerX: 0.52
    }, first.end, 600);
    expect(wobble.results.some(step => step.status === 'done')).toBeTrue();
  });

  it('starts the second again when the head moves by more than a quarter of an eye span', () => {
    const calibrator = new FaceCalibrator();
    const first = feed(calibrator, { centerX: 0.5 }, 0, 600);
    // A quarter of 0.2 is 0.05: 0.07 away is too far.
    const moved = feed(calibrator, { centerX: 0.57 }, first.end, 0);
    expect(moved.results[0].progress).toBe(0);
  });

  it('pauses while there is no face or more than one, and starts over afterwards', () => {
    const calibrator = new FaceCalibrator();
    const first = feed(calibrator, {}, 0, 800);

    const none = feed(calibrator, { faces: 0 }, first.end, 100);
    expect(none.results.every(step => step.status === 'no-face' && step.progress === 0)).toBeTrue();

    const crowd = feed(calibrator, { faces: 2 }, none.end, 100);
    expect(
      crowd.results.every(step => step.status === 'many-faces' && step.progress === 0),
    ).toBeTrue();

    // The 800 ms before do not count: a fresh second is needed.
    const back = feed(calibrator, {}, crowd.end, 500);
    expect(back.results.some(step => step.status === 'done')).toBeFalse();
    const rest = feed(calibrator, {}, back.end, 700);
    expect(rest.results.some(step => step.status === 'done')).toBeTrue();
  });

  it('does not count a long pause in the frames as steady looking', () => {
    const calibrator = new FaceCalibrator();
    const first = feed(calibrator, {}, 0, 600);
    const after: CalibrationStep = calibrator.step(
      faceFrame(),
      VIDEO_WIDTH,
      VIDEO_HEIGHT,
      first.end + 5000,
    );
    expect(after.status).toBe('collecting');
    expect(after.progress).toBe(0);
  });

  it('can calibrate again after finishing', () => {
    const calibrator = new FaceCalibrator();
    // Stops on the frame that completes the first calibration, so no extra frame joins the second.
    const first = feed(calibrator, {}, 0, 1030);
    expect(first.results[first.results.length - 1].status).toBe('done');
    const second = feed(calibrator, { roll: -2 }, first.end, 1100);
    const done = second.results.find(step => step.status === 'done');
    expect(done!.neutral!.roll).toBeCloseTo(-2, 4);
  });
});

describe('messages', () => {
  it('says what is wrong with the number of faces', () => {
    expect(faceProblemMessage(1)).toBeNull();
    expect(faceProblemMessage(0)).toBe('Chưa thấy mặt · đến gần và nhìn camera');
    expect(faceProblemMessage(3)).toBe('Chỉ một người trước camera');
  });

  it('shows the seconds collected so far', () => {
    expect(calibrationMessage('collecting', 0.6)).toBe('Nhìn thẳng vào camera · 0.6 / 1 giây');
    expect(calibrationMessage('collecting', 0)).toBe('Nhìn thẳng vào camera · 0.0 / 1 giây');
    expect(calibrationMessage('no-face', 0)).toBe('Chưa thấy mặt · đến gần và nhìn camera');
    expect(calibrationMessage('many-faces', 0)).toBe('Chỉ một người trước camera');
  });
});

describe('card text helpers', () => {
  it('splits the pinyin in brackets from the word', () => {
    expect(splitOption('水 (shuǐ)')).toEqual({
      main: '水',
      note: 'shuǐ'
    });
    expect(splitOption('Cảm ơn')).toEqual({
      main: 'Cảm ơn',
      note: ''
    });
    expect(splitOption('中国 (Zhōngguó)')).toEqual({
      main: '中国',
      note: 'Zhōngguó'
    });
    expect(splitOption('(x)')).toEqual({
      main: '(x)',
      note: ''
    });
  });

  it('shrinks long words', () => {
    expect(wordSize('水')).toBe('big');
    expect(wordSize('老师好')).toBe('big');
    expect(wordSize('Tạm biệt')).toBe('small');
    expect(wordSize('朋友们好吗')).toBe('mid');
  });

  it('knows when the player is typing', () => {
    expect(isTypingTarget(document.createElement('input'))).toBeTrue();
    expect(isTypingTarget(document.createElement('textarea'))).toBeTrue();
    expect(isTypingTarget(document.createElement('button'))).toBeFalse();
    expect(isTypingTarget(null)).toBeFalse();
    expect(isTypingTarget(document)).toBeFalse();
  });
});
