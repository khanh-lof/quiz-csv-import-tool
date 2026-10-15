import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  afterRenderEffect,
  computed,
  effect,
  forwardRef,
  inject,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { GameAudio } from '../../../../game/game-audio';
import { INDEX_TIP, PinchDetector, PointSmoother, mapToStage } from '../../../../game/gestures';
import { QuestionView, StageGameBase, VisionFrame } from '../../../../game/stage-game';
import { stageDef } from '../../../../game/stages';
import { VisionService } from '../../../../game/vision.service';
import { sentenceOf } from '../../../../models/gesture-quiz';
import {
  CompletionTimer,
  TargetRect,
  TargetSelector,
  UNDO_TARGET,
  applyTarget,
  hitTest,
  isComplete,
  isValidTarget,
  lineTarget,
  orderOf,
  poolTarget,
} from './word-order-logic';

// A hand that has produced no fingertip for this long is gone: the cursor hides and the smoothing
// starts afresh when it comes back, instead of gliding in from where it was last seen.
const HAND_LOST_MS = 250;

// The layout is sized in "units" (1% of a 16:9 stage's width, see the stylesheet). The camera cursor's
// hit areas are grown by this many units around every target.
const HIT_PAD_UNITS = 0.8;
const UNIT_ASPECT = 16 / 9;

// Stage 6: the player builds the sentence by picking word tiles in order. With the camera on, the
// index fingertip is a cursor; a tile is picked by resting on it (dwell) or by pinching thumb and index
// while on it. The mouse, touch and keyboard work too. The rules live in `word-order-logic.ts`.
@Component({
  selector: 'app-word-order-game',
  standalone: true,
  providers: [{ provide: StageGameBase, useExisting: forwardRef(() => WordOrderGame) }],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './word-order-game.html',
  styleUrl: './word-order-game.css',
})
export class WordOrderGame extends StageGameBase {
  readonly visionKind = stageDef(6).vision;

  private readonly vision = inject(VisionService);
  private readonly audio = inject(GameAudio);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly cursorElement = viewChild<ElementRef<HTMLElement>>('cursor');

  protected readonly undoId = UNDO_TARGET;

  protected readonly chunks = computed(() => this.question().chunks ?? []);

  // The tiles the player has placed, as positions in `chunks` (not texts, as two tiles may read the
  // same), in the order placed; a new question starts again from none.
  protected readonly line = linkedSignal<QuestionView, number[]>({
    source: this.question,
    computation: () => [],
  });

  // Set once the finished sentence has been reported, so nothing can change it before the verdict
  // arrives.
  private readonly submitted = linkedSignal<QuestionView, boolean>({
    source: this.question,
    computation: () => false,
  });

  protected readonly locked = computed(
    () => this.paused() || this.reveal() !== null || this.submitted(),
  );

  // One entry per chunk: the answer line has a slot for each, filled from the left as tiles are placed.
  protected readonly slots = computed(() => {
    const line = this.line();
    const chunks = this.chunks();
    return chunks.map((_, position) => ({
      filled: position < line.length,
      text: position < line.length ? chunks[line[position]] : '',
    }));
  });

  // The pool keeps every tile in its own place and only hides the placed ones, so picking one never
  // moves the others under a cursor that is resting still.
  protected readonly pool = computed(() => {
    const line = this.line();
    return this.chunks().map((text, index) => ({ index, text, placed: line.includes(index) }));
  });

  protected readonly verdict = computed(() => {
    const reveal = this.reveal();
    return reveal === null ? null : reveal.correct ? 'right' : 'wrong';
  });

  protected readonly solution = computed(() => sentenceOf(this.reveal()?.correctOrder ?? []));

  protected readonly hovered = signal<string | null>(null);
  protected readonly handVisible = signal(false);
  protected readonly pinched = signal(false);

  protected readonly hint = computed(() => {
    if (!this.cameraActive()) {
      return 'Bấm các mảnh theo đúng thứ tự câu';
    }
    return this.handVisible()
      ? 'Chỉ ngón trỏ vào từng mảnh theo thứ tự · giữ yên hoặc chụm ngón để chọn'
      : 'Đưa tay vào khung hình';
  });

  private readonly selector = new TargetSelector();
  private readonly completion = new CompletionTimer();
  // Not reset with the question: the fingers may still be closed from the last pick, and the detector
  // has to see them open before it can report the next press.
  private readonly pinch = new PinchDetector();
  private smoother = new PointSmoother();
  private smootherSpan = 0;

  // Measured from the DOM (host-relative pixels) after every render and resize.
  private stage = { width: 0, height: 0 };
  private hitPad = 0;
  private rects: TargetRect[] = [];
  private elements = new Map<string, HTMLElement>();

  // The smoothed fingertip in stage pixels, null while there is no hand.
  private cursor: { x: number; y: number } | null = null;
  private handSeenAt = Number.NEGATIVE_INFINITY;
  // A press seen by `onFrame`, handed to the selector by the next `tick`.
  private pendingPinch = false;
  private ringElement: HTMLElement | null = null;

  constructor() {
    super();

    // A new question starts clean: no dwell or cooldown carried over, nothing hovered.
    effect(() => {
      this.question();
      untracked(() => {
        this.selector.reset();
        this.completion.reset();
        this.pendingPinch = false;
        this.hovered.set(null);
        this.paintProgress(null, 0);
      });
    });

    // The hit areas are the tiles' own boxes, so they are measured again whenever anything that can
    // move them has changed.
    afterRenderEffect(() => {
      this.line();
      this.question();
      this.reveal();
      this.cameraActive();
      this.hint();
      this.measure();
    });

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.measure());
      observer.observe(this.host.nativeElement);
      inject(DestroyRef).onDestroy(() => observer.disconnect());
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (this.locked() || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) {
      return;
    }
    // Digits name the tiles by their place in the pool (the number shown on each), which does not
    // change as tiles are placed and taken back.
    if (/^[1-9]$/.test(event.key)) {
      this.activate(poolTarget(Number(event.key) - 1));
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      this.activate(UNDO_TARGET);
    }
  }

  override onFrame(frame: VisionFrame, now: number): void {
    if (frame.kind !== 'hand') {
      return;
    }
    const landmarks = frame.hand.landmarks;
    const size = this.vision.videoSize();
    const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : 1;

    // The pinch is tracked even while the game is locked, so its state is right when play resumes.
    const pinch = this.pinch.step(landmarks, now, aspect);
    if (pinch.changed === 'down') {
      this.pendingPinch = true;
    }
    if (pinch.pinched !== this.pinched()) {
      this.pinched.set(pinch.pinched);
    }

    const tip = landmarks?.[INDEX_TIP];
    if (!tip || !(this.stage.width > 0 && this.stage.height > 0)) {
      return;
    }
    const point = mapToStage(
      tip.x,
      tip.y,
      size.width,
      size.height,
      this.stage.width,
      this.stage.height,
    );
    this.cursor = this.smootherFor(this.stage.width, this.stage.height).filter(
      point.x,
      point.y,
      now,
    );
    this.handSeenAt = now;
    if (!this.handVisible()) {
      this.handVisible.set(true);
    }
  }

  override tick(_dt: number, now: number): void {
    if (this.locked()) {
      // Nothing can be picked now (paused, judged, or already reported); the cursor keeps following
      // the hand but every hover starts over once play resumes.
      this.selector.reset();
      this.pendingPinch = false;
      this.paintProgress(null, 0);
      if (this.hovered() !== null) {
        this.hovered.set(null);
      }
      this.placeCursor();
      return;
    }

    const cameraOn = this.cameraActive();
    if (this.handVisible() && (!cameraOn || now - this.handSeenAt > HAND_LOST_MS)) {
      this.cursor = null;
      this.smoother.reset();
      this.handVisible.set(false);
    }

    const hover =
      cameraOn && this.cursor !== null
        ? hitTest(this.cursor.x, this.cursor.y, this.targetRects(), this.hitPad)
        : null;
    const step = this.selector.step({
      hover,
      pinchDown: this.pendingPinch,
      pinched: this.pinched(),
      now,
    });
    this.pendingPinch = false;

    if (step.hovered !== this.hovered()) {
      this.hovered.set(step.hovered);
    }
    if (step.started) {
      this.audio.play('select');
    }
    if (step.halfway) {
      this.audio.play('charge');
    }
    this.paintProgress(step.target, step.progress);
    this.placeCursor();
    if (step.picked !== null) {
      this.activate(step.picked);
    }

    // A full line is reported after a short pause, which a tile taken back cancels.
    if (this.completion.step(isComplete(this.line(), this.chunks().length), now)) {
      this.submitted.set(true);
      this.choose.emit(orderOf(this.line(), this.chunks()));
    }
  }

  protected poolId(index: number): string {
    return poolTarget(index);
  }

  protected lineId(position: number): string {
    return lineTarget(position);
  }

  // What every way of picking comes down to: a click, a key, a dwell or a pinch.
  protected activate(target: string): void {
    if (this.locked()) {
      return;
    }
    const next = applyTarget(this.line(), target, this.chunks().length);
    if (next === null) {
      return;
    }
    this.line.set(next);
    this.audio.play('slice');
  }

  // The targets the cursor can hit right now: those on screen that still exist (a tile just placed is
  // still in the measured rectangles until the next render).
  private targetRects(): TargetRect[] {
    const line = this.line();
    const size = this.chunks().length;
    return this.rects.filter(rect => isValidTarget(line, rect.id, size));
  }

  private smootherFor(width: number, height: number): PointSmoother {
    const span = Math.max(width, height);
    if (span !== this.smootherSpan) {
      // The filter's speed term is per unit of the value, so for pixels it scales with the stage size.
      this.smoother = new PointSmoother({ minCutoff: 1.5, beta: 8 / span });
      this.smootherSpan = span;
    }
    return this.smoother;
  }

  private measure(): void {
    const host = this.host.nativeElement;
    const origin = host.getBoundingClientRect();
    this.stage = { width: origin.width, height: origin.height };
    this.hitPad = (Math.min(origin.width, origin.height * UNIT_ASPECT) / 100) * HIT_PAD_UNITS;

    const rects: TargetRect[] = [];
    const elements = new Map<string, HTMLElement>();
    host.querySelectorAll<HTMLElement>('[data-target]').forEach(element => {
      const id = element.dataset['target'];
      if (!id) {
        return;
      }
      const box = element.getBoundingClientRect();
      rects.push({
        id,
        x: box.left - origin.left,
        y: box.top - origin.top,
        width: box.width,
        height: box.height,
      });
      elements.set(id, element);
    });
    this.rects = rects;
    this.elements = elements;
  }

  // The dwell progress is written straight to the DOM (as a CSS variable the ring is drawn from)
  // instead of through a signal, because it changes on every frame.
  private paintProgress(target: string | null, progress: number): void {
    const element = target === null ? null : (this.elements.get(target) ?? null);
    if (element !== this.ringElement) {
      this.ringElement?.style.removeProperty('--dwell');
      this.ringElement = element;
    }
    const value = element === null ? '0' : progress.toFixed(3);
    element?.style.setProperty('--dwell', value);
    this.cursorElement()?.nativeElement.style.setProperty('--dwell', value);
  }

  private placeCursor(): void {
    const element = this.cursorElement()?.nativeElement;
    if (element && this.cursor) {
      const { x, y } = this.cursor;
      element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
}

// Keys typed into a field are not answers.
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}
