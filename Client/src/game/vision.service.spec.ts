import { WritableSignal } from '@angular/core';
import { fakeAsync, flushMicrotasks, TestBed, tick } from '@angular/core/testing';
import type { VisionKind } from './stage-game';
import {
  CameraState,
  FaceResultLike,
  HandResultLike,
  ModelState,
  toFaceFrame,
  toHandFrame,
  VisionService,
} from './vision.service';

const point = (x: number, y: number) => ({
  x,
  y,
  z: 0
});
const category = (categoryName: string, score: number) => ({
  categoryName,
  score
});

describe('toHandFrame', () => {
  it('returns the first hand, its landmarks and its top gesture', () => {
    const landmarks = Array.from({ length: 21 }, (_, i) => point(i / 21, 0.5));
    const result: HandResultLike = {
      landmarks: [landmarks, [point(0, 0)]],
      gestures: [[category('Thumb_Up', 0.93)], [category('Open_Palm', 0.8)]],
    };
    const frame = toHandFrame(result);
    expect(frame.landmarks).toBe(landmarks);
    expect(frame.gesture).toBe('Thumb_Up');
    expect(frame.gestureScore).toBe(0.93);
  });

  it('turns the canned None gesture into null', () => {
    const frame = toHandFrame({
      landmarks: [[point(0.5, 0.5)]],
      gestures: [[category('None', 0.7)]]
    });
    expect(frame.landmarks?.length).toBe(1);
    expect(frame.gesture).toBeNull();
  });

  it('takes the best-scoring category rather than trusting the order', () => {
    const frame = toHandFrame({
      landmarks: [[point(0.5, 0.5)]],
      gestures: [[category('Victory', 0.2), category('Thumb_Down', 0.8)]],
    });
    expect(frame.gesture).toBe('Thumb_Down');
    expect(frame.gestureScore).toBe(0.8);
  });

  it('keeps the landmarks of a hand that has no gesture result', () => {
    const frame = toHandFrame({
      landmarks: [[point(0.1, 0.2)]],
      gestures: []
    });
    expect(frame.landmarks).toEqual([point(0.1, 0.2)]);
    expect(frame.gesture).toBeNull();
    expect(frame.gestureScore).toBe(0);
  });

  it('reports nothing in view as null landmarks', () => {
    const empty = {
      landmarks: null,
      gesture: null,
      gestureScore: 0
    };
    expect(toHandFrame({
      landmarks: [],
      gestures: []
    })).toEqual(empty);
    expect(toHandFrame(null)).toEqual(empty);
    expect(toHandFrame(undefined)).toEqual(empty);
  });
});

describe('toFaceFrame', () => {
  it('counts the faces and returns the first one with its blendshapes by name', () => {
    const first = [point(0.4, 0.4), point(0.5, 0.5)];
    const result: FaceResultLike = {
      faceLandmarks: [first, [point(0.9, 0.9)]],
      faceBlendshapes: [
        { categories: [category('_neutral', 0.1), category('jawOpen', 0.62)] },
        { categories: [category('jawOpen', 0.01)] },
      ],
    };
    const frame = toFaceFrame(result);
    expect(frame.faces).toBe(2);
    expect(frame.landmarks).toBe(first);
    expect(frame.blendshapes).toEqual({
      _neutral: 0.1,
      jawOpen: 0.62
    });
  });

  it('reports no face as zero faces, null landmarks and no blendshapes', () => {
    const empty = {
      faces: 0,
      landmarks: null,
      blendshapes: {}
    };
    expect(toFaceFrame({
      faceLandmarks: [],
      faceBlendshapes: []
    })).toEqual(empty);
    expect(toFaceFrame(null)).toEqual(empty);
    expect(toFaceFrame(undefined)).toEqual(empty);
  });

  it('copes with a result that has no blendshapes', () => {
    const frame = toFaceFrame({ faceLandmarks: [[point(0.5, 0.5)]] });
    expect(frame.faces).toBe(1);
    expect(frame.blendshapes).toEqual({});
  });
});

// The service's private state, reached through a cast so the tests can stand in for the camera and
// MediaPipe without loading either.
interface Internals {
  loadRuntime: () => Promise<unknown>;
  cameraStateSignal: WritableSignal<CameraState>;
  states: Record<VisionKind, WritableSignal<ModelState>>;
  recognizers: { hand: unknown; face: unknown };
}

describe('VisionService', () => {
  let service: VisionService;
  let internals: Internals;

  beforeEach(() => {
    service = TestBed.inject(VisionService);
    internals = service as unknown as Internals;
  });

  describe('initial state', () => {
    it('has the camera off, the models idle and no video size', () => {
      expect(service.cameraState()).toBe('off');
      expect(service.cameraMessage()).toBe('');
      expect(service.modelState('hand')()).toBe('idle');
      expect(service.modelState('face')()).toBe('idle');
      expect(service.videoSize()).toEqual({
        width: 0,
        height: 0
      });
    });

    it('owns one muted inline video', () => {
      expect(service.video instanceof HTMLVideoElement).toBeTrue();
      expect(service.video.playsInline).toBeTrue();
      expect(service.video.muted).toBeTrue();
      expect(service.video.autoplay).toBeTrue();
      expect(service.video.classList.contains('qt-camera-video')).toBeTrue();
    });

    it('detects nothing while the camera is off', () => {
      expect(service.detect('hand', 1000)).toBeNull();
      expect(service.detect('face', 1000)).toBeNull();
    });

    it('detects nothing while the camera is on but the model is not ready', () => {
      internals.cameraStateSignal.set('on');
      expect(service.detect('hand', 1000)).toBeNull();
    });
  });

  describe('camera', () => {
    let getUserMedia: jasmine.Spy;

    beforeEach(() => {
      getUserMedia = spyOn(navigator.mediaDevices, 'getUserMedia');
    });

    function expectFailure(state: CameraState): void {
      expect(service.cameraState()).toBe(state);
      expect(service.cameraMessage()).not.toBe('');
    }

    it('maps a refused permission to denied', async () => {
      getUserMedia.and.rejectWith(new DOMException('refused', 'NotAllowedError'));
      await service.startCamera();
      expectFailure('denied');
    });

    it('maps a security error to denied', async () => {
      getUserMedia.and.rejectWith(new DOMException('insecure', 'SecurityError'));
      await service.startCamera();
      expectFailure('denied');
    });

    it('maps a missing camera to unavailable', async () => {
      getUserMedia.and.rejectWith(new DOMException('none', 'NotFoundError'));
      await service.startCamera();
      expectFailure('unavailable');
      getUserMedia.and.rejectWith(new DOMException('constraints', 'OverconstrainedError'));
      await service.startCamera();
      expectFailure('unavailable');
    });

    it('maps a camera used by another app to an error that names the cause', async () => {
      getUserMedia.and.rejectWith(new DOMException('busy', 'NotReadableError'));
      await service.startCamera();
      expectFailure('error');
      expect(service.cameraMessage()).toContain('Ứng dụng khác');
    });

    it('maps anything else to a generic error', async () => {
      getUserMedia.and.rejectWith(new Error('weird'));
      await service.startCamera();
      expectFailure('error');
    });

    it('reports unavailable when the browser has no camera API', async () => {
      spyOnProperty(navigator, 'mediaDevices', 'get').and.returnValue(
        undefined as unknown as MediaDevices,
      );
      await service.startCamera();
      expectFailure('unavailable');
      expect(getUserMedia).not.toHaveBeenCalled();
    });

    it('lets a stopCamera during the permission prompt win', async () => {
      let resolveStream!: (stream: MediaStream) => void;
      getUserMedia.and.returnValue(new Promise<MediaStream>(resolve => (resolveStream = resolve)));
      const started = service.startCamera();
      expect(service.cameraState()).toBe('starting');
      expect(service.startCamera()).toBe(started);

      service.stopCamera();
      expect(service.cameraState()).toBe('off');

      const track = { stop: jasmine.createSpy('stop') };
      resolveStream({ getTracks: () => [track] } as unknown as MediaStream);
      await started;

      expect(track.stop).toHaveBeenCalled();
      expect(service.cameraState()).toBe('off');
      expect(service.video.srcObject).toBeNull();
    });

    it('turns on with a stream, and goes off again when the track ends', async () => {
      const stream = document.createElement('canvas').captureStream();
      const track = stream.getVideoTracks()[0];
      getUserMedia.and.resolveTo(stream);
      spyOn(service.video, 'play').and.resolveTo();

      await service.startCamera();

      expect(service.cameraState()).toBe('on');
      expect(service.cameraMessage()).toBe('');
      expect(service.video.srcObject).toBe(stream);
      expect(getUserMedia).toHaveBeenCalledWith({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false,
      });
      // Already on: no second prompt.
      await service.startCamera();
      expect(getUserMedia).toHaveBeenCalledTimes(1);

      track.dispatchEvent(new Event('ended'));
      expect(service.cameraState()).toBe('off');
      expect(service.cameraMessage()).toContain('bị ngắt');
      expect(service.video.srcObject).toBeNull();
    });

    it('stops the tracks and clears the message on stopCamera', async () => {
      getUserMedia.and.rejectWith(new DOMException('refused', 'NotAllowedError'));
      await service.startCamera();
      expect(service.cameraMessage()).not.toBe('');

      const stream = document.createElement('canvas').captureStream();
      getUserMedia.and.resolveTo(stream);
      spyOn(service.video, 'play').and.resolveTo();
      await service.startCamera();
      expect(service.cameraMessage()).toBe('');

      service.stopCamera();
      expect(stream.getVideoTracks()[0].readyState).toBe('ended');
      expect(service.cameraState()).toBe('off');
      expect(service.videoSize()).toEqual({
        width: 0,
        height: 0
      });
    });

    it('can start again after a failure', async () => {
      getUserMedia.and.rejectWith(new DOMException('busy', 'NotReadableError'));
      await service.startCamera();
      expect(service.cameraState()).toBe('error');

      getUserMedia.and.resolveTo(document.createElement('canvas').captureStream());
      spyOn(service.video, 'play').and.resolveTo();
      await service.startCamera();
      expect(service.cameraState()).toBe('on');
      service.stopCamera();
    });
  });

  describe('models', () => {
    // Stands in for the MediaPipe module: both task classes hand out the same fake recognizer.
    function fakeRuntime(recognizer: unknown, create?: jasmine.Spy) {
      const createFromOptions =
        create ?? jasmine.createSpy('createFromOptions').and.resolveTo(recognizer);
      return {
        runtime: {
          vision: {
            GestureRecognizer: { createFromOptions },
            FaceLandmarker: { createFromOptions },
          },
          fileset: { wasmLoaderPath: 'loader' },
        },
        createFromOptions,
      };
    }

    it('creates the hand model once, however many callers ask', async () => {
      const recognizer = {};
      const {
        runtime,
        createFromOptions
      } = fakeRuntime(recognizer);
      const loadRuntime = spyOn(internals, 'loadRuntime').and.resolveTo(runtime);

      const first = service.ensureModel('hand');
      const second = service.ensureModel('hand');
      expect(service.modelState('hand')()).toBe('loading');
      await Promise.all([first, second]);
      await service.ensureModel('hand');

      expect(service.modelState('hand')()).toBe('ready');
      expect(loadRuntime).toHaveBeenCalledTimes(1);
      expect(createFromOptions).toHaveBeenCalledTimes(1);
      const [fileset, options] = createFromOptions.calls.argsFor(0);
      expect(fileset).toBe(runtime.fileset);
      expect(options.baseOptions.modelAssetPath).toContain('gesture_recognizer');
      expect(options.baseOptions.delegate).toBe('GPU');
      expect(options.runningMode).toBe('VIDEO');
      expect(options.numHands).toBe(1);
      expect(service.modelState('face')()).toBe('idle');
    });

    it('asks the face model for blendshapes and a second face', async () => {
      const {
        runtime,
        createFromOptions
      } = fakeRuntime({});
      spyOn(internals, 'loadRuntime').and.resolveTo(runtime);

      await service.ensureModel('face');

      const options = createFromOptions.calls.argsFor(0)[1];
      expect(options.baseOptions.modelAssetPath).toContain('face_landmarker');
      expect(options.numFaces).toBe(2);
      expect(options.outputFaceBlendshapes).toBeTrue();
      expect(options.runningMode).toBe('VIDEO');
      expect(service.modelState('face')()).toBe('ready');
    });

    it('falls back to the CPU delegate when the GPU one cannot be created', async () => {
      const create = jasmine
        .createSpy('createFromOptions')
        .and.callFake((_fileset: unknown, options: { baseOptions: { delegate: string } }) =>
          options.baseOptions.delegate === 'GPU'
            ? Promise.reject(new Error('no gpu'))
            : Promise.resolve({}),
        );
      const { runtime } = fakeRuntime({}, create);
      spyOn(internals, 'loadRuntime').and.resolveTo(runtime);

      await service.ensureModel('hand');

      const delegates = create.calls.allArgs().map(args => args[1].baseOptions.delegate);
      expect(delegates).toEqual(['GPU', 'CPU']);
      expect(service.modelState('hand')()).toBe('ready');
    });

    it('rejects on failure and loads again on the next call', async () => {
      const loadRuntime = spyOn(internals, 'loadRuntime').and.rejectWith(new Error('offline'));

      await expectAsync(service.ensureModel('hand')).toBeRejectedWithError('offline');
      expect(service.modelState('hand')()).toBe('error');

      const { runtime } = fakeRuntime({});
      loadRuntime.and.resolveTo(runtime);
      await service.ensureModel('hand');
      expect(service.modelState('hand')()).toBe('ready');
      expect(loadRuntime).toHaveBeenCalledTimes(2);
    });

    it('rejects after 30 s, and still becomes ready if the load finishes late', fakeAsync(() => {
      let finish!: (runtime: unknown) => void;
      spyOn(internals, 'loadRuntime').and.returnValue(
        new Promise(resolve => (finish = resolve)),
      );
      let error: unknown;
      service.ensureModel('hand').catch(e => (error = e));

      tick(29_999);
      expect(error).toBeUndefined();
      expect(service.modelState('hand')()).toBe('loading');
      tick(1);
      expect(error).toBeInstanceOf(Error);
      expect(service.modelState('hand')()).toBe('error');

      finish(fakeRuntime({}).runtime);
      flushMicrotasks();
      expect(service.modelState('hand')()).toBe('ready');
    }));
  });

  describe('detect', () => {
    let videoTime: number;
    let recognizeForVideo: jasmine.Spy;
    let detectForVideo: jasmine.Spy;
    let closeHand: jasmine.Spy;

    function handResult(): HandResultLike {
      return {
        landmarks: [[point(0.5, 0.5)]],
        gestures: [[category('Thumb_Up', 0.9)]]
      };
    }

    beforeEach(() => {
      videoTime = 1;
      const video = service.video;
      Object.defineProperty(video, 'readyState', {
        value: 4,
        configurable: true
      });
      Object.defineProperty(video, 'videoWidth', {
        value: 640,
        configurable: true
      });
      Object.defineProperty(video, 'videoHeight', {
        value: 480,
        configurable: true
      });
      Object.defineProperty(video, 'currentTime', {
        get: () => videoTime,
        configurable: true
      });

      recognizeForVideo = jasmine.createSpy('recognizeForVideo').and.callFake(handResult);
      closeHand = jasmine.createSpy('close');
      detectForVideo = jasmine.createSpy('detectForVideo').and.returnValue({
        faceLandmarks: [[point(0.5, 0.5)]],
        faceBlendshapes: [{ categories: [category('jawOpen', 0.7)] }],
      });
      internals.recognizers.hand = {
        recognizeForVideo,
        close: closeHand
      };
      internals.recognizers.face = {
        detectForVideo,
        close: jasmine.createSpy('close')
      };
      internals.states.hand.set('ready');
      internals.states.face.set('ready');
      internals.cameraStateSignal.set('on');
    });

    it('reports the video size while on', () => {
      expect(service.videoSize()).toEqual({
        width: 640,
        height: 480
      });
    });

    it('returns a converted hand frame', () => {
      const frame = service.detect('hand', 1000);
      expect(frame).toEqual({
        kind: 'hand',
        hand: {
          landmarks: [point(0.5, 0.5)],
          gesture: 'Thumb_Up',
          gestureScore: 0.9
        },
      });
      expect(recognizeForVideo).toHaveBeenCalledWith(service.video, 1000);
    });

    it('returns a converted face frame', () => {
      const frame = service.detect('face', 1000);
      expect(frame).toEqual({
        kind: 'face',
        face: {
          faces: 1,
          landmarks: [point(0.5, 0.5)],
          blendshapes: { jawOpen: 0.7 }
        },
      });
      expect(detectForVideo).toHaveBeenCalledWith(service.video, 1000);
    });

    it('returns a frame with null landmarks when nothing is in view', () => {
      recognizeForVideo.and.returnValue({
        landmarks: [],
        gestures: []
      });
      expect(service.detect('hand', 1000)).toEqual({
        kind: 'hand',
        hand: {
          landmarks: null,
          gesture: null,
          gestureScore: 0
        },
      });
      detectForVideo.and.returnValue({
        faceLandmarks: [],
        faceBlendshapes: []
      });
      expect(service.detect('face', 1000)).toEqual({
        kind: 'face',
        face: {
          faces: 0,
          landmarks: null,
          blendshapes: {}
        },
      });
    });

    it('skips a video frame it has already seen', () => {
      expect(service.detect('hand', 1000)).not.toBeNull();
      expect(service.detect('hand', 1100)).toBeNull();
      videoTime = 2;
      expect(service.detect('hand', 1100)).not.toBeNull();
    });

    it('skips a call made less than 28 ms after the last detection', () => {
      expect(service.detect('hand', 1000)).not.toBeNull();
      videoTime = 2;
      expect(service.detect('hand', 1020)).toBeNull();
      expect(service.detect('hand', 1028)).not.toBeNull();
    });

    it('keeps the two models independent of each other', () => {
      expect(service.detect('hand', 1000)).not.toBeNull();
      expect(service.detect('face', 1000)).not.toBeNull();
    });

    it('waits for the video to have data', () => {
      Object.defineProperty(service.video, 'readyState', {
        value: 1,
        configurable: true
      });
      expect(service.detect('hand', 1000)).toBeNull();
      expect(recognizeForVideo).not.toHaveBeenCalled();
    });

    it('gives MediaPipe strictly increasing timestamps, also from a tiny clock', () => {
      const stamps: number[] = [];
      recognizeForVideo.and.callFake((_video: unknown, ts: number) => {
        stamps.push(ts);
        return handResult();
      });
      for (const now of [0, 30, 60, 90.5, 125]) {
        videoTime++;
        service.detect('hand', now);
      }
      expect(stamps).toEqual([0, 30, 60, 90.5, 125]);
      expect(stamps.every((t, i) => i === 0 || t > stamps[i - 1])).toBeTrue();
    });

    it('swallows an error, and marks the model failed after six in a row', () => {
      recognizeForVideo.and.throwError('gpu lost');
      let now = 1000;
      for (let i = 0; i < 5; i++) {
        videoTime++;
        now += 50;
        expect(service.detect('hand', now)).toBeNull();
        expect(service.modelState('hand')()).toBe('ready');
      }
      videoTime++;
      now += 50;
      expect(service.detect('hand', now)).toBeNull();
      expect(service.modelState('hand')()).toBe('error');
      expect(closeHand).toHaveBeenCalled();
      expect(service.detect('hand', now + 50)).toBeNull();
      // The face model is unaffected.
      expect(service.modelState('face')()).toBe('ready');
    });

    it('counts only consecutive failures', () => {
      let now = 1000;
      const next = (): void => {
        videoTime++;
        now += 50;
        service.detect('hand', now);
      };
      for (let round = 0; round < 3; round++) {
        recognizeForVideo.and.throwError('flaky');
        for (let i = 0; i < 5; i++) {
          next();
        }
        recognizeForVideo.and.callFake(handResult);
        next();
      }
      expect(service.modelState('hand')()).toBe('ready');
    });
  });
});
