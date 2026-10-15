import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  HostListener,
  inject,
  linkedSignal,
} from '@angular/core';

import { GameAudio } from '../../../../game/game-audio';
import { QuestionView, StageGameBase, VisionFrame } from '../../../../game/stage-game';
import { stageDef } from '../../../../game/stages';
import { VisionService } from '../../../../game/vision.service';
import { HoldSelector, isPlainKey, ringOffset } from '../../../../game/hold-select';
import {
  FINGER_HOLD_MS,
  fingerBadge,
  fingerChoice,
  fingerKeyIndex,
  FingerReader,
  fingerStatus,
  FingerView,
  hasHanzi,
  IDLE_FINGER_VIEW,
  MAX_FINGERS,
  sameFingerView,
} from './finger-count-logic';

// Stage 5: four answers numbered 1 to 4, picked by showing that many fingers (thumb not counted) to
// the camera and holding them, or by a click or the 1-4 keys when there is no camera.
@Component({
  selector: 'app-finger-count-game',
  standalone: true,
  providers: [{
    provide: StageGameBase,
    useExisting: forwardRef(() => FingerCountGame)
  }],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './finger-count-game.html',
  styleUrl: './finger-count-game.css',
})
export class FingerCountGame extends StageGameBase {
  readonly visionKind = stageDef(5).vision;

  // The four fingers of the pictogram on each card.
  protected readonly fingers = Array.from({ length: MAX_FINGERS }, (_, finger) => finger);
  // input cannot answer twice.
  protected readonly picked = linkedSignal<QuestionView, number | null>({
    source: this.question,
    computation: () => null,
  });
  // every question.
  protected readonly view = linkedSignal<QuestionView, FingerView>({
    source: this.question,
    computation: () => IDLE_FINGER_VIEW,
    equal: sameFingerView,
  });
  protected readonly locked = computed(() => this.paused() || this.reveal() !== null);
  protected readonly badge = computed(() => fingerBadge(this.view().count));
  protected readonly status = computed(() => fingerStatus(this.view()));

  // The option the player answered with for this question, by gesture, click or key, so that a second
  private readonly audio = inject(GameAudio);

  // What the camera side shows: the finger count, the charging card and its progress. Back to idle on
  private readonly vision = inject(VisionService);
  private readonly reader = new FingerReader();
  private readonly selector = new HoldSelector(FINGER_HOLD_MS);
  // The question the gate was last locked for, see `onFrame`.
  private lockedFor: QuestionView | null = null;

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    const index = fingerKeyIndex(event.key, this.question().options.length);
    if (index !== null && isPlainKey(event)) {
      this.answer(index, false);
    }
  }

  override onFrame(frame: VisionFrame, now: number): void {
    if (frame.kind !== 'hand' || this.locked() || this.picked() !== null) {
      return;
    }
    // The gate has to be locked for every new question, so that the hand of the last answer does not
    // answer this one at once. Checking here, where the frame is used, is immediate; an effect on
    // `question()` would run a change detection later.
    const question = this.question();
    if (question !== this.lockedFor) {
      this.lockedFor = question;
      this.selector.lock();
    }

    const {
      width,
      height
    } = this.vision.videoSize();
    const count = this.reader.read(frame.hand, width > 0 && height > 0 ? width / height : 1);
    const step = this.selector.step(fingerChoice(count, question.options.length), now);
    if (step.cue) {
      this.audio.play(step.cue);
    }
    if (step.selected !== undefined) {
      this.answer(step.selected, true);
    } else {
      this.view.set({
        armed: step.armed,
        choice: step.choice,
        progress: step.progress,
        count
      });
    }
  }

  protected onCard(index: number, event: Event): void {
    this.answer(index, false);
    // A button that keeps the focus would turn the Enter that moves on to the next question into a
    // click on this card.
    (event.currentTarget as HTMLElement | null)?.blur();
  }

  protected offset(index: number): number {
    return ringOffset(this.view(), index);
  }

  protected isHan(option: string): boolean {
    return hasHanzi(option);
  }

  protected isCorrect(index: number): boolean {
    return this.reveal()?.correctIndex === index;
  }

  protected isWrong(index: number): boolean {
    const reveal = this.reveal();
    return reveal !== null && !reveal.correct && reveal.chosen === index;
  }

  // One answer per question. A gesture answer leaves its ring full on the chosen card, the other ways
  // of answering clear whatever the camera was charging.
  private answer(index: number, byCamera: boolean): void {
    if (this.locked() || this.picked() !== null || index >= this.question().options.length) {
      return;
    }
    this.picked.set(index);
    this.view.set(
      byCamera
        ? {
          armed: false,
          choice: index,
          progress: 1,
          count: index + 1
        }
        : IDLE_FINGER_VIEW,
    );
    this.choose.emit(index);
  }
}
