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
import { HoldSelector, isPlainKey, ringOffset } from '../../../../game/hold-select';
import {
  IDLE_THUMB_VIEW,
  THUMB_HOLD_MS,
  THUMB_TARGETS,
  TRUE_INDEX,
  ThumbReader,
  ThumbView,
  sameThumbView,
  thumbKeyIndex,
  thumbStatus,
} from './true-false-logic';

// Stage 1: a statement to judge, answered with a thumb held up (Đúng) or down (Sai) in front of the
// camera, or with a click or the 1/2 and arrow keys when there is no camera.
@Component({
  selector: 'app-true-false-game',
  standalone: true,
  providers: [{ provide: StageGameBase, useExisting: forwardRef(() => TrueFalseGame) }],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './true-false-game.html',
  styleUrl: './true-false-game.css',
})
export class TrueFalseGame extends StageGameBase {
  readonly visionKind = stageDef(1).vision;

  protected readonly targets = THUMB_TARGETS;
  // Which target is Đúng, for the template to colour it green and the other red.
  protected readonly trueIndex = TRUE_INDEX;

  private readonly audio = inject(GameAudio);
  private readonly reader = new ThumbReader();
  private readonly selector = new HoldSelector(THUMB_HOLD_MS);
  // The question the gate was last locked for, see `onFrame`.
  private lockedFor: QuestionView | null = null;

  // The option the player answered with for this question, by gesture, click or key, so that a second
  // input cannot answer twice.
  protected readonly picked = linkedSignal<QuestionView, number | null>({
    source: this.question,
    computation: () => null,
  });

  // What the camera side shows: the charging target and its progress. Back to idle on every question.
  protected readonly view = linkedSignal<QuestionView, ThumbView>({
    source: this.question,
    computation: () => IDLE_THUMB_VIEW,
    equal: sameThumbView,
  });

  protected readonly locked = computed(() => this.paused() || this.reveal() !== null);
  protected readonly status = computed(() => thumbStatus(this.view()));

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    const index = thumbKeyIndex(event.key);
    if (index !== null && isPlainKey(event)) {
      this.answer(index, false);
    }
  }

  override onFrame(frame: VisionFrame, now: number): void {
    if (frame.kind !== 'hand' || this.locked() || this.picked() !== null) {
      return;
    }
    // The gate has to be locked for every new question, so that the thumb of the last answer does not
    // answer this one at once. Checking here, where the frame is used, is immediate; an effect on
    // `question()` would run a change detection later.
    const question = this.question();
    if (question !== this.lockedFor) {
      this.lockedFor = question;
      this.selector.lock();
    }

    const shown = this.reader.read(frame.hand);
    const step = this.selector.step(shown, now);
    if (step.cue) {
      this.audio.play(step.cue);
    }
    if (step.selected !== undefined) {
      this.answer(step.selected, true);
    } else {
      this.view.set({ armed: step.armed, choice: step.choice, progress: step.progress, shown });
    }
  }

  protected onTarget(index: number, event: Event): void {
    this.answer(index, false);
    // A button that keeps the focus would turn the Enter that moves on to the next question into a
    // click on this target.
    (event.currentTarget as HTMLElement | null)?.blur();
  }

  protected offset(index: number): number {
    return ringOffset(this.view(), index);
  }

  protected isCorrect(index: number): boolean {
    return this.reveal()?.correctIndex === index;
  }

  protected isWrong(index: number): boolean {
    const reveal = this.reveal();
    return reveal !== null && !reveal.correct && reveal.chosen === index;
  }

  // One answer per question. A gesture answer leaves its ring full on the chosen target, the other
  // ways of answering clear whatever the camera was charging.
  private answer(index: number, byCamera: boolean): void {
    if (this.locked() || this.picked() !== null || index >= this.question().options.length) {
      return;
    }
    this.picked.set(index);
    this.view.set(
      byCamera
        ? { armed: false, choice: index, progress: 1, shown: index === 0 ? 0 : 1 }
        : IDLE_THUMB_VIEW,
    );
    this.choose.emit(index);
  }
}
