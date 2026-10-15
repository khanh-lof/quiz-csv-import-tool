import { Directive, input, output, signal } from '@angular/core';

// Which MediaPipe task feeds a game: hand gestures (GestureRecognizer) or the face (FaceLandmarker).
// The page only runs the task a stage needs, so a game never receives frames of the other kind.
export type VisionKind = 'hand' | 'face';

// A landmark as MediaPipe reports it: normalized to the camera image (0..1), NOT mirrored. The camera
// preview is shown mirrored like a mirror, so a game that draws on it flips x itself (1 - x).
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

// The first hand in the frame, or `landmarks: null` when none is visible. `gesture` is MediaPipe's
// canned gesture name ('Thumb_Up', 'Thumb_Down', ...), null when none was recognized.
export interface HandFrame {
  landmarks: Point3[] | null;
  gesture: string | null;
  gestureScore: number;
}

// The first face in the frame: `faces` counts every face seen, `landmarks` is null when there is none,
// and `blendshapes` maps each blendshape name ('jawOpen', ...) to its 0..1 score.
export interface FaceFrame {
  faces: number;
  landmarks: Point3[] | null;
  blendshapes: Record<string, number>;
}

export type VisionFrame =
  | { kind: 'hand'; hand: HandFrame }
  | { kind: 'face'; face: FaceFrame };

// What the page hands a game for one question. The page has already shuffled `options`, so the game
// shows them in the order given. For stage 6 (`options` empty) `chunks` are the shuffled pieces of the
// sentence and `question` is its Vietnamese meaning. For stage 1 the options are always
// ['Đúng', 'Sai'] in that order, so index 0 is the thumbs-up answer.
export interface QuestionView {
  stage: number;
  question: string;
  options: string[];
  chunks?: string[];
}

// What a game reports: the index into `QuestionView.options`, or (stage 6) the chunks in the order the
// player pointed at them.
export type Choice = number | string[];

// The verdict the page sends back after judging a choice. `chosen` is null when time ran out.
// `correctIndex` is set for option stages and `correctOrder` for stage 6, so the game can highlight
// the right answer without knowing the quiz itself.
export interface Reveal {
  chosen: Choice | null;
  correct: boolean;
  correctIndex?: number;
  correctOrder?: string[];
}

// The contract between the gesture page and one stage's game component. The page owns everything about
// the quiz (shuffling the options, the timer, judging the answer, scoring, moving on); a game only
// turns player input into a `Choice` and reports it through `choose`, then shows `reveal` when the page
// sends it. Each game component provides itself as StageGameBase (`useExisting`), so the page can reach
// whichever game is on screen through one `viewChild(StageGameBase)`.
//
// Input rule: while `reveal` is non-null (the answer is already judged) or `paused` is true, a game
// must ignore all input, camera and mouse/keyboard alike, and must not emit `choose`.
@Directive()
export abstract class StageGameBase {
  // Which MediaPipe result this game wants in `onFrame`.
  abstract readonly visionKind: VisionKind;

  readonly question = input.required<QuestionView>();
  readonly reveal = input<Reveal | null>(null);
  readonly paused = input(false);
  // Whether the camera feeds the game; without it a game still works from mouse and keyboard.
  readonly cameraActive = input(false);

  readonly choose = output<Choice>();

  // Face games set this to false until the player's neutral pose is calibrated, so the page can hold
  // the timer back; every other game stays ready from the start.
  readonly ready = signal(true);

  // Called with the latest MediaPipe result for `visionKind` from the page's requestAnimationFrame
  // loop, which runs outside the Angular zone: a game that shows a value in its template must write it
  // to a signal, and `now` is a performance.now() timestamp in ms.
  onFrame(_frame: VisionFrame, _now: number): void {
  }

  // Called on every animation frame (`dt` in seconds since the previous one) by canvas-drawn games for
  // their own simulation and drawing. Games that only react to frames can leave it alone.
  tick(_dt: number, _now: number): void {
  }
}
