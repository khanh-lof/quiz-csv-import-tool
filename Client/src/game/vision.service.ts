import { Injectable, Signal, signal } from '@angular/core';
// Type-only: MediaPipe itself is loaded with a dynamic import in `ensureModel`, so it stays in its
// own lazy chunk and is only downloaded when a player turns the camera on.
import type { FaceLandmarker, GestureRecognizer } from '@mediapipe/tasks-vision';
import type { FaceFrame, HandFrame, Point3, VisionFrame, VisionKind } from './stage-game';

export type CameraState = 'off' | 'starting' | 'on' | 'denied' | 'unavailable' | 'error';
export type ModelState = 'idle' | 'loading' | 'ready' | 'error';

type MediaPipe = typeof import('@mediapipe/tasks-vision');
// MediaPipe does not export the fileset type, so derive it from the function that returns it.
type WasmFileset = Awaited<ReturnType<MediaPipe['FilesetResolver']['forVisionTasks']>>;

// The WASM runtime is copied next to the app by the `assets` entry in angular.json, so it is loaded
// from the same origin; the models themselves are too big to ship and come from Google's bucket.
const WASM_PATH = '/mediapipe/wasm';
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const MODEL_TIMEOUT_MS = 30_000;
// A camera that grants permission but never delivers a frame (privacy shutter, driver fault) must
// not leave the page stuck on "starting".
const PLAY_TIMEOUT_MS = 4_000;
// ~35 detections per second at most: the video itself rarely delivers more, and the model is the
// heaviest thing the page runs.
const MIN_DETECT_INTERVAL_MS = 28;
const MAX_CONSECUTIVE_FAILURES = 6;

const CAMERA_MESSAGES = {
  denied:
    'Quyền dùng camera đã bị từ chối. Hãy cho phép camera cho trang này trong trình duyệt rồi bật lại, hoặc chơi bằng chuột và bàn phím.',
  unavailable:
    'Không tìm thấy camera trên thiết bị này. Bạn vẫn chơi được bằng chuột và bàn phím.',
  unsupported:
    'Trình duyệt này không hỗ trợ camera (hãy dùng Chrome hoặc Edge, và mở trang qua HTTPS). Bạn vẫn chơi được bằng chuột và bàn phím.',
  inUse:
    'Camera đang được ứng dụng khác sử dụng (ví dụ Zoom hoặc Meet). Hãy đóng ứng dụng đó rồi bật lại, hoặc chơi bằng chuột và bàn phím.',
  other: 'Không bật được camera. Bạn vẫn chơi được bằng chuột và bàn phím.',
  disconnected:
    'Camera đã bị ngắt kết nối. Hãy cắm lại camera rồi bật lại, hoặc chơi bằng chuột và bàn phím.',
} as const;

// The slices of MediaPipe's results the converters read. Typed structurally (MediaPipe's own result
// types satisfy them) so the converters can be tested without loading MediaPipe.
export interface CategoryLike {
  categoryName: string;
  score: number;
}

export interface HandResultLike {
  landmarks: readonly (readonly Point3[])[];
  gestures: readonly (readonly CategoryLike[])[];
}

export interface FaceResultLike {
  faceLandmarks: readonly (readonly Point3[])[];
  faceBlendshapes?: readonly { categories: readonly CategoryLike[] }[];
}

// The first hand and its best gesture. MediaPipe reports "no canned gesture" as the category
// `None`, which becomes `gesture: null` so a game never has to know that name. The landmark objects
// are passed through as they are (they carry extra fields such as `visibility` that nothing reads)
// to avoid copying 21 points on every frame.
export function toHandFrame(result: HandResultLike | null | undefined): HandFrame {
  const landmarks = result?.landmarks?.[0];
  if (!landmarks || landmarks.length === 0) {
    return { landmarks: null, gesture: null, gestureScore: 0 };
  }
  let top: CategoryLike | null = null;
  for (const category of result?.gestures?.[0] ?? []) {
    if (!top || category.score > top.score) {
      top = category;
    }
  }
  const name = top?.categoryName ?? '';
  return {
    landmarks: landmarks as Point3[],
    gesture: name === '' || name === 'None' ? null : name,
    gestureScore: top?.score ?? 0,
  };
}

// How many faces there are, the first one's landmarks, and its blendshapes keyed by name.
export function toFaceFrame(result: FaceResultLike | null | undefined): FaceFrame {
  const landmarks = result?.faceLandmarks?.[0];
  if (!result || !landmarks) {
    return { faces: 0, landmarks: null, blendshapes: {} };
  }
  const blendshapes: Record<string, number> = {};
  for (const category of result.faceBlendshapes?.[0]?.categories ?? []) {
    blendshapes[category.categoryName] = category.score;
  }
  return { faces: result.faceLandmarks.length, landmarks: landmarks as Point3[], blendshapes };
}

// The camera and the two MediaPipe models, shared by the gesture page and every game. The page owns
// the loop: it starts the camera, shows `video`, and calls `detect` once per animation frame
// outside the Angular zone. The models stay cached for the session, so a second visit does not
// download them again.
@Injectable({ providedIn: 'root' })
export class VisionService {
  // One element for the whole session; the page appends it to its DOM and mirrors it with CSS. The
  // frames MediaPipe sees are never mirrored.
  readonly video: HTMLVideoElement = VisionService.createVideo();

  private readonly cameraStateSignal = signal<CameraState>('off');
  private readonly cameraMessageSignal = signal('');
  readonly cameraState: Signal<CameraState> = this.cameraStateSignal.asReadonly();
  readonly cameraMessage: Signal<string> = this.cameraMessageSignal.asReadonly();

  private readonly states = {
    hand: signal<ModelState>('idle'),
    face: signal<ModelState>('idle'),
  };
  private readonly readonlyStates = {
    hand: this.states.hand.asReadonly(),
    face: this.states.face.asReadonly(),
  };

  private stream: MediaStream | null = null;
  // Bumped by every start and by `stopCamera`, so an asynchronous start that finds the number
  // changed knows it was cancelled and must clean up instead of turning the camera on.
  private generation = 0;
  private starting: Promise<void> | null = null;

  private readonly recognizers: { hand: GestureRecognizer | null; face: FaceLandmarker | null } = {
    hand: null,
    face: null,
  };
  private readonly loads: { hand: Promise<void> | null; face: Promise<void> | null } = {
    hand: null,
    face: null,
  };
  private runtime: Promise<{ vision: MediaPipe; fileset: WasmFileset }> | null = null;

  private readonly lastVideoTime: Record<VisionKind, number> = { hand: -1, face: -1 };
  private readonly lastDetectAt: Record<VisionKind, number> = { hand: -Infinity, face: -Infinity };
  // Per model and never reset: a model instance demands strictly increasing timestamps for its
  // whole life, across camera restarts too.
  private readonly lastTimestamp: Record<VisionKind, number> = { hand: -1, face: -1 };
  private readonly failures: Record<VisionKind, number> = { hand: 0, face: 0 };

  modelState(kind: VisionKind): Signal<ModelState> {
    return this.readonlyStates[kind];
  }

  // The stream's intrinsic size, which the games need to map landmarks onto the cropped preview.
  videoSize(): { width: number; height: number } {
    if (this.cameraStateSignal() !== 'on') {
      return { width: 0, height: 0 };
    }
    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }

  // Never throws: every failure ends in a camera state and a message, because the quiz is still
  // playable with the mouse.
  startCamera(): Promise<void> {
    if (this.cameraStateSignal() === 'on') {
      return Promise.resolve();
    }
    if (this.starting) {
      return this.starting;
    }
    const run: Promise<void> = this.openCamera(++this.generation).finally(() => {
      if (this.starting === run) {
        this.starting = null;
      }
    });
    this.starting = run;
    return run;
  }

  stopCamera(): void {
    // Invalidates a start that is still waiting for the permission prompt or for the first frame.
    this.generation++;
    this.starting = null;
    this.releaseStream();
    this.cameraStateSignal.set('off');
    this.cameraMessageSignal.set('');
  }

  // Loads and creates the model for `kind` (once per session). Safe to call before the camera
  // starts, so the download runs in parallel with the permission prompt. Rejects on failure or
  // timeout; a later call retries, and picks up a load that is still running instead of starting
  // a second one.
  ensureModel(kind: VisionKind): Promise<void> {
    if (this.recognizers[kind]) {
      this.states[kind].set('ready');
      return Promise.resolve();
    }
    this.states[kind].set('loading');
    const load = (this.loads[kind] ??= this.createModel(kind));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.states[kind].set('error');
        reject(new Error('Tải mô hình nhận diện quá lâu.'));
      }, MODEL_TIMEOUT_MS);
      load.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  // The latest result for `kind`, or null when there is nothing new to report (camera off, model
  // not ready, no new video frame, or called again too soon). "Nothing in view" is a frame with
  // `landmarks: null`, so a null return never means "no hand".
  detect(kind: VisionKind, now: number): VisionFrame | null {
    if (this.cameraStateSignal() !== 'on' || this.states[kind]() !== 'ready') {
      return null;
    }
    const video = this.video;
    if (video.readyState < 2 || !video.videoWidth) {
      return null;
    }
    const videoTime = video.currentTime;
    if (
      videoTime === this.lastVideoTime[kind] ||
      now - this.lastDetectAt[kind] < MIN_DETECT_INTERVAL_MS
    ) {
      return null;
    }
    this.lastVideoTime[kind] = videoTime;
    this.lastDetectAt[kind] = now;
    const timestamp = Math.max(now, this.lastTimestamp[kind] + 1);
    this.lastTimestamp[kind] = timestamp;
    try {
      let frame: VisionFrame | null = null;
      const { hand, face } = this.recognizers;
      if (kind === 'hand' && hand) {
        frame = { kind: 'hand', hand: toHandFrame(hand.recognizeForVideo(video, timestamp)) };
      } else if (kind === 'face' && face) {
        frame = { kind: 'face', face: toFaceFrame(face.detectForVideo(video, timestamp)) };
      }
      this.failures[kind] = 0;
      return frame;
    } catch {
      if (++this.failures[kind] >= MAX_CONSECUTIVE_FAILURES) {
        this.dropModel(kind);
      }
      return null;
    }
  }

  private static createVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.className = 'qt-camera-video';
    return video;
  }

  private async openCamera(generation: number): Promise<void> {
    this.cameraStateSignal.set('starting');
    this.cameraMessageSignal.set('');
    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail('unavailable', CAMERA_MESSAGES.unsupported);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (error) {
      if (generation === this.generation) {
        this.failFrom(error);
      }
      return;
    }
    if (generation !== this.generation) {
      // stopCamera() ran while the permission prompt was open: the late stream must not stay on.
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    this.stream = stream;
    this.video.srcObject = stream;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.stream === stream) {
        this.generation++;
        this.releaseStream();
        this.cameraStateSignal.set('off');
        this.cameraMessageSignal.set(CAMERA_MESSAGES.disconnected);
      }
    });
    await this.startPlayback();
    if (generation !== this.generation) {
      return;
    }
    this.lastVideoTime.hand = -1;
    this.lastVideoTime.face = -1;
    this.failures.hand = 0;
    this.failures.face = 0;
    this.cameraStateSignal.set('on');
  }

  // Waits for playback to begin (so the intrinsic size is known) but not forever. A rejected play()
  // is harmless: the video is muted, so autoplay is allowed, and detection is gated on readyState.
  private async startPlayback(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, PLAY_TIMEOUT_MS);
    });
    try {
      await Promise.race([Promise.resolve(this.video.play()).catch(() => undefined), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    try {
      this.video.pause();
    } catch {
      // Nothing to pause.
    }
    this.video.srcObject = null;
    this.lastVideoTime.hand = -1;
    this.lastVideoTime.face = -1;
  }

  private fail(state: 'denied' | 'unavailable' | 'error', message: string): void {
    this.cameraStateSignal.set(state);
    this.cameraMessageSignal.set(message);
  }

  private failFrom(error: unknown): void {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      this.fail('denied', CAMERA_MESSAGES.denied);
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      this.fail('unavailable', CAMERA_MESSAGES.unavailable);
    } else if (name === 'NotReadableError') {
      this.fail('error', CAMERA_MESSAGES.inUse);
    } else {
      this.fail('error', CAMERA_MESSAGES.other);
    }
  }

  // Creates the model; unlike `ensureModel`'s promise it is not bound to the 30 s timeout, so a
  // slow download that finishes late still ends as 'ready' for the next call.
  private createModel(kind: VisionKind): Promise<void> {
    const load = (async () => {
      const { vision, fileset } = await this.loadRuntime();
      if (kind === 'hand') {
        this.recognizers.hand = await this.withGpuFallback(delegate =>
          vision.GestureRecognizer.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: HAND_MODEL, delegate },
            runningMode: 'VIDEO',
            numHands: 1,
            minHandDetectionConfidence: 0.5,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          }),
        );
      } else {
        this.recognizers.face = await this.withGpuFallback(delegate =>
          vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: FACE_MODEL, delegate },
            runningMode: 'VIDEO',
            // Two, so the page can tell the player when a second face is in view.
            numFaces: 2,
            outputFaceBlendshapes: true,
            minFaceDetectionConfidence: 0.5,
            minFacePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          }),
        );
      }
      this.failures[kind] = 0;
      this.states[kind].set('ready');
    })();
    load.catch(() => {
      this.loads[kind] = null;
      this.states[kind].set('error');
    });
    return load;
  }

  // The runtime (the MediaPipe module and its WASM fileset) is shared by both models.
  private loadRuntime(): Promise<{ vision: MediaPipe; fileset: WasmFileset }> {
    this.runtime ??= (async () => {
      const vision = await import('@mediapipe/tasks-vision');
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
      return { vision, fileset };
    })().catch(error => {
      this.runtime = null;
      throw error;
    });
    return this.runtime;
  }

  // The GPU delegate is fast but unavailable on some machines (and fails at creation, not at use),
  // so it is tried first and the CPU one is the fallback.
  private async withGpuFallback<T>(create: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> {
    try {
      return await create('GPU');
    } catch {
      return await create('CPU');
    }
  }

  // After repeated failures the model is considered broken: release it so a later `ensureModel`
  // builds a fresh one, and tell the page through the state signal.
  private dropModel(kind: VisionKind): void {
    const recognizer = this.recognizers[kind];
    this.recognizers[kind] = null;
    this.loads[kind] = null;
    try {
      recognizer?.close();
    } catch {
      // Already unusable.
    }
    this.states[kind].set('error');
  }
}
