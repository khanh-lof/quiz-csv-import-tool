import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  forwardRef,
  HostListener,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';

import { GameAudio } from '../../../../game/game-audio';
import { FaceFrame, QuestionView, StageGameBase, VisionFrame } from '../../../../game/stage-game';
import { stageDef } from '../../../../game/stages';
import { VisionService } from '../../../../game/vision.service';
import { FaceCalibrationPanel } from './face-calibration-panel';
import { CalibrationStatus, FaceCalibrator, FacePose, isTypingTarget, splitOption, wordSize, } from './face-common';
import { HeadTiltReader, meterPercent, sideToIndex, tiltHint } from './head-tilt-logic';

// The circumference of the hold ring (r = 96 in a 200 x 200 viewBox).
const RING_LENGTH = 603.19;

const IDLE_HINT = 'Nghiêng hoặc dịch đầu nhẹ để chọn';

// Stage 2: two cards, left and right, chosen by leaning the head toward one and holding it. Without
// the camera the cards are clicked or picked with the keys (1 or ←, 2 or →).
@Component({
  selector: 'app-head-tilt-game',
  imports: [FaceCalibrationPanel],
  providers: [{
    provide: StageGameBase,
    useExisting: forwardRef(() => HeadTiltGame)
  }],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './head-tilt-game.html',
  styleUrl: './head-tilt-game.css',
})
export class HeadTiltGame extends StageGameBase {
  readonly visionKind = stageDef(2).vision;
  // twice.
  protected readonly picked = linkedSignal<QuestionView, number | null>({
    source: this.question,
    computation: () => null,
  });
  protected readonly locked = computed(() => this.paused() || this.reveal() !== null);
  // Option 0 is the left card and option 1 the right one, in the order the page shuffled them.
  protected readonly cards = computed(() =>
    [0, 1].map(index => {
      const {
        main,
        note
      } = splitOption(this.question().options[index] ?? '');
      return {
        index,
        main,
        note,
        size: wordSize(main)
      };
    }),
  );
  protected readonly calibrationStatus = signal<CalibrationStatus>('collecting');
  protected readonly calibrationProgress = signal(0);
  // Which card is charging, and how far (0..1 of the hold).
  protected readonly activeSide = signal<0 | 1 | null>(null);

  // The option the player chose for this question (by click, key or head), so nothing can answer
  protected readonly progress = signal(0);
  protected readonly lean = signal(0);
  protected readonly hint = signal(IDLE_HINT);
  protected readonly problem = signal(false);
  protected readonly meterLeft = computed(() => meterPercent(this.lean()));
  protected readonly ringOffset = computed(() => RING_LENGTH * (1 - this.progress()));
  protected readonly hintText = computed(() =>
    this.reveal() !== null ? 'Đưa đầu về giữa để chuẩn bị câu tiếp' : this.hint(),
  );
  private readonly vision = inject(VisionService);
  private readonly audio = inject(GameAudio);
  private readonly calibrator = new FaceCalibrator();
  private readonly reader = new HeadTiltReader();
  private neutral: FacePose | null = null;
  private currentQuestion: QuestionView | null = null;

  constructor() {
    super();
    // The camera can come on (or go off) at any time, also in the middle of a stage: whenever it
    // comes on the player's neutral pose is measured again, and the page waits meanwhile.
    effect(() => {
      const active = this.cameraActive();
      untracked(() => (active ? this.beginCalibration() : this.endCamera()));
    });
    effect(() => {
      this.question();
      untracked(() => this.syncQuestion());
    });
    effect(() => {
      if (this.locked()) {
        untracked(() => this.clearCharge());
      }
    });
  }

  override onFrame(frame: VisionFrame, now: number): void {
    if (frame.kind !== 'face' || !this.cameraActive()) {
      return;
    }
    this.syncQuestion();
    const {
      width,
      height
    } = this.vision.videoSize();
    if (!this.ready()) {
      this.calibrate(frame.face, width, height, now);
      return;
    }
    if (this.locked() || !this.neutral) {
      return;
    }

    const step = this.reader.step(frame.face, width, height, this.neutral, now);
    if (step.recalibrate) {
      this.beginCalibration();
      return;
    }
    if (step.cue) {
      this.audio.play(step.cue);
    }
    this.lean.set(Math.round(step.lean * 50) / 50);
    this.progress.set(Math.round(step.progress * 50) / 50);
    this.activeSide.set(step.side === null ? null : sideToIndex(step.side));
    this.hint.set(tiltHint(step));
    this.problem.set(step.invalid);
    if (step.selected !== null) {
      this.pick(step.selected);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (
      this.locked() ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isTypingTarget(event.target)
    ) {
      return;
    }
    let index = -1;
    if (event.key === '1' || event.key === 'ArrowLeft') {
      index = 0;
    } else if (event.key === '2' || event.key === 'ArrowRight') {
      index = 1;
    }
    if (index >= 0) {
      event.preventDefault();
      this.pick(index);
    }
  }

  protected pick(index: number): void {
    if (this.locked() || this.picked() !== null || index >= this.question().options.length) {
      return;
    }
    this.picked.set(index);
    this.activeSide.set(null);
    this.choose.emit(index);
  }

  protected recalibrate(): void {
    if (this.cameraActive()) {
      this.beginCalibration();
    }
  }

  protected isCorrect(index: number): boolean {
    return this.reveal()?.correctIndex === index;
  }

  protected isWrong(index: number): boolean {
    const reveal = this.reveal();
    return reveal !== null && !reveal.correct && reveal.chosen === index;
  }

  private calibrate(face: FaceFrame, w: number, h: number, now: number): void {
    const step = this.calibrator.step(face, w, h, now);
    this.calibrationStatus.set(step.status);
    this.calibrationProgress.set(step.progress);
    if (step.neutral) {
      this.neutral = step.neutral;
      // The head is in the middle by definition right after calibrating; the gate still arms itself
      // on the first frames, so a lean that follows counts normally.
      this.reader.reset();
      this.ready.set(true);
    }
  }

  private beginCalibration(): void {
    this.neutral = null;
    this.calibrator.reset();
    this.reader.reset();
    this.calibrationStatus.set('collecting');
    this.calibrationProgress.set(0);
    this.clearCharge();
    this.ready.set(false);
  }

  private endCamera(): void {
    this.neutral = null;
    this.calibrator.reset();
    this.reader.reset();
    this.clearCharge();
    this.ready.set(true);
  }

  // A new question starts from scratch: the head has to be back in the middle before it counts.
  private syncQuestion(): void {
    const question = this.question();
    if (question === this.currentQuestion) {
      return;
    }
    this.currentQuestion = question;
    this.reader.lock();
    this.clearCharge();
  }

  private clearCharge(): void {
    this.activeSide.set(null);
    this.progress.set(0);
    this.lean.set(0);
    this.hint.set(IDLE_HINT);
    this.problem.set(false);
  }
}
