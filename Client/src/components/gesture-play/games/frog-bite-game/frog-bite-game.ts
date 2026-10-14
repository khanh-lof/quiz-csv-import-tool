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
import { clamp } from '../../../../game/gestures';
import { FaceFrame, QuestionView, StageGameBase, VisionFrame } from '../../../../game/stage-game';
import { stageDef } from '../../../../game/stages';
import { VisionService } from '../../../../game/vision.service';
import { FaceCalibrationPanel } from '../head-tilt-game/face-calibration-panel';
import {
  CalibrationStatus,
  FaceCalibrator,
  FacePose,
  isTypingTarget,
  splitOption,
  wordSize,
} from '../head-tilt-game/face-common';
import { BITE_OPEN, FrogReader, Lane, frogHint } from './frog-logic';

const LANES = 3;

// The keys that move the frog when there is no camera (down returns it to the middle lane).
const ARROW_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowDown'];

// The mouth meter is full at this jawOpen, a bit above the bite threshold, so a bite lands in the
// upper half of the bar.
const MOUTH_FULL = 0.7;

const IDLE_HINT = 'Dịch đầu sang làn đáp án';
const MISSED_HINT = 'Giữ yên ở một làn thêm chút rồi mới đớp';
const MISSED_HINT_MS = 1400;

// Stage 3: three lanes, each with one answer; the frog follows the player's head from lane to lane
// and the player bites by opening the mouth wide and closing it. Without the camera the cards are
// clicked or picked with 1 / 2 / 3, or the frog is moved with ← ↓ → and bites on Space.
@Component({
  selector: 'app-frog-bite-game',
  imports: [FaceCalibrationPanel],
  providers: [{ provide: StageGameBase, useExisting: forwardRef(() => FrogBiteGame) }],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './frog-bite-game.html',
  styleUrl: './frog-bite-game.css',
})
export class FrogBiteGame extends StageGameBase {
  readonly visionKind = stageDef(3).vision;

  private readonly vision = inject(VisionService);
  private readonly audio = inject(GameAudio);
  private readonly calibrator = new FaceCalibrator();
  private readonly reader = new FrogReader();
  private neutral: FacePose | null = null;
  private currentQuestion: QuestionView | null = null;
  private missedUntil = 0;

  // The lane the player bit (by click, key or mouth) for this question, so nothing can answer twice.
  protected readonly picked = linkedSignal<QuestionView, number | null>({
    source: this.question,
    computation: () => null,
  });

  protected readonly locked = computed(() => this.paused() || this.reveal() !== null);

  // One lane per option, in the order the page shuffled them; a lane without an option stays empty.
  protected readonly lanes = computed(() =>
    Array.from({ length: LANES }, (_, index) => {
      const text = this.question().options[index];
      const { main, note } = splitOption(text ?? '');
      return { index, filled: text !== undefined, main, note, size: wordSize(main) };
    }),
  );

  protected readonly calibrationStatus = signal<CalibrationStatus>('collecting');
  protected readonly calibrationProgress = signal(0);
  // The lane the head (or the arrow keys) put the frog in, and whether it has stayed there long enough
  // for a bite to count.
  protected readonly lane = signal<Lane>(1);
  protected readonly stable = signal(false);
  protected readonly jawOpen = signal(0);
  protected readonly mouthOpen = signal(false);
  protected readonly hint = signal(IDLE_HINT);
  protected readonly problem = signal(false);

  // After a bite the frog stays at the lane it bit.
  protected readonly frogLane = computed<number>(() => this.picked() ?? this.lane());
  // The lane whose bite counts right now: the frog has held it long enough and nothing is locked.
  protected readonly armedLane = computed<number | null>(() =>
    this.cameraActive() && this.stable() && !this.locked() ? this.frogLane() : null,
  );
  protected readonly frogLeft = computed(() => ((this.frogLane() + 0.5) / LANES) * 100);
  // How wide the frog's mouth is, 0..1: it gapes when the player's mouth is open and when it bites.
  protected readonly frogMouth = computed(() =>
    this.picked() !== null ? 1 : clamp(this.jawOpen() / MOUTH_FULL, 0, 1),
  );
  protected readonly mouthPercent = computed(() => clamp(this.jawOpen() / MOUTH_FULL, 0, 1) * 100);
  protected readonly biteMarkPercent = (BITE_OPEN / MOUTH_FULL) * 100;
  protected readonly hintText = computed(() =>
    this.reveal() !== null ? 'Xem đáp án nhé!' : this.picked() !== null ? 'Đớp!' : this.hint(),
  );

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
  }

  override onFrame(frame: VisionFrame, now: number): void {
    if (frame.kind !== 'face' || !this.cameraActive()) {
      return;
    }
    this.syncQuestion();
    const { width, height } = this.vision.videoSize();
    if (!this.ready()) {
      this.calibrate(frame.face, width, height, now);
      return;
    }
    if (this.locked() || !this.neutral) {
      return;
    }

    const step = this.reader.step(frame.face, width, height, this.neutral, now);
    if (step.laneChanged) {
      this.audio.play('select');
    }
    this.lane.set(step.lane);
    this.stable.set(step.stable);
    this.jawOpen.set(Math.round(step.jawOpen * 50) / 50);
    this.mouthOpen.set(step.mouthOpen);
    this.problem.set(step.invalid);
    if (step.missed) {
      this.missedUntil = now + MISSED_HINT_MS;
    }
    this.hint.set(now < this.missedUntil ? MISSED_HINT : frogHint(step));
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
    const digit = Number(event.key);
    if (digit >= 1 && digit <= LANES) {
      event.preventDefault();
      this.pick(digit - 1);
    } else if (event.key === ' ') {
      event.preventDefault();
      this.pick(this.lane());
    } else if (!this.cameraActive() && ARROW_KEYS.includes(event.key)) {
      // With the camera on the head moves the frog; the arrows would only fight it.
      event.preventDefault();
      this.moveFrog(event.key);
    }
  }

  protected pick(index: number): void {
    if (this.locked() || this.picked() !== null || index >= this.question().options.length) {
      return;
    }
    this.picked.set(index);
    this.lane.set(index as Lane);
    this.audio.play('slice');
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

  private moveFrog(key: string): void {
    const last = Math.max(0, Math.min(LANES, this.question().options.length) - 1);
    const lane = key === 'ArrowLeft' ? this.lane() - 1 : key === 'ArrowRight' ? this.lane() + 1 : 1;
    const next = clamp(lane, 0, last) as Lane;
    if (next !== this.lane()) {
      this.lane.set(next);
      this.audio.play('select');
    }
  }

  private calibrate(face: FaceFrame, w: number, h: number, now: number): void {
    const step = this.calibrator.step(face, w, h, now);
    this.calibrationStatus.set(step.status);
    this.calibrationProgress.set(step.progress);
    if (step.neutral) {
      this.neutral = step.neutral;
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
    this.clearCamera();
    this.ready.set(false);
  }

  private endCamera(): void {
    this.neutral = null;
    this.calibrator.reset();
    this.reader.reset();
    this.clearCamera();
    this.ready.set(true);
  }

  // A new question: the mouth has to be seen closed again before a bite counts.
  private syncQuestion(): void {
    const question = this.question();
    if (question === this.currentQuestion) {
      return;
    }
    this.currentQuestion = question;
    this.reader.newQuestion();
    this.missedUntil = 0;
    this.hint.set(IDLE_HINT);
  }

  private clearCamera(): void {
    this.stable.set(false);
    this.jawOpen.set(0);
    this.mouthOpen.set(false);
    this.hint.set(IDLE_HINT);
    this.problem.set(false);
    this.missedUntil = 0;
  }
}
