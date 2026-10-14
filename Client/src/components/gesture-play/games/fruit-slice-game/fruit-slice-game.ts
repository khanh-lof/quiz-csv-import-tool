import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  forwardRef,
  HostListener,
  inject,
  linkedSignal,
  NgZone,
  signal,
  untracked,
  viewChild,
  viewChildren
} from '@angular/core';

import { GameAudio } from '../../../../game/game-audio';
import { INDEX_TIP, mapToStage } from '../../../../game/gestures';
import { QuestionView, StageGameBase, VisionFrame } from '../../../../game/stage-game';
import { stageDef } from '../../../../game/stages';
import { VisionService } from '../../../../game/vision.service';
import { drawCursor, drawField, drawTrail, TrailPoint } from './fruit-slice-draw';
import { FruitField, HandCursor, Segment, SLOTS } from './fruit-slice-physics';

// A stroke with the mouse or a finger has to travel this far before it can cut anything, so a plain
// click on a fruit is not a swipe.
const MIN_STROKE_PX = 10;
// Seconds-long gaps between camera frames (the model still loading, a dropped video) must not leave
// the cursor frozen on the stage, so it is dropped after this long without any reading.
const STALE_HAND_MS = 600;
// The share of the normal particle count used when the player asked for reduced motion.
const REDUCED_EFFECTS = 0.4;
const POINTER_TRAIL_RGB = '40,190,235';
const HAND_TRAIL_RGB = '255,196,0';

// The mouse or finger stroke in progress, if any: which pointer it is, where it was last seen and
// how far it has travelled.
interface Stroke {
  id: number | null;
  last: { x: number; y: number } | null;
  length: number;
}

// Shrinks the text of an answer or question box until it fits, so a long phrase and a single
// character are both as large as the box allows. Ported from the prototype's `fitSize`.
function fitSize(box: HTMLElement, span: HTMLElement, start: number): number {
  const style = getComputedStyle(box);
  const width = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  let size = Math.max(12, start);
  if (!(width > 0) || !(height > 0)) {
    span.style.fontSize = `${size}px`;
    return size;
  }
  for (let i = 0; i < 45; i++) {
    span.style.fontSize = `${size}px`;
    if (span.scrollWidth <= width + 1 && span.offsetHeight <= height + 1) {
      break;
    }
    size *= 0.92;
    if (size < 11) {
      size = 11;
      span.style.fontSize = '11px';
      break;
    }
  }
  return size;
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

// Stage 4, "Chém hoa quả": the question and three coloured answer boxes sit on top, and waves of
// three unlabeled fruits (watermelon, apple, lemon) are thrown up the stage. The player finds the
// right answer, then slashes the fruit of the same colour: green box = watermelon, red = apple,
// yellow = lemon. The slash comes from the index fingertip, the mouse or a finger on the canvas, or
// the keys 1/2/3. The first fruit cut is the answer; after that the game ignores everything until
// the next question.
@Component({
  selector: 'app-fruit-slice-game',
  standalone: true,
  providers: [{ provide: StageGameBase, useExisting: forwardRef(() => FruitSliceGame) }],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './fruit-slice-game.html',
  styleUrl: './fruit-slice-game.css'
})
export class FruitSliceGame extends StageGameBase {
  readonly visionKind = stageDef(4).vision;

  private readonly vision = inject(VisionService);
  private readonly audio = inject(GameAudio);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('field');
  private readonly topRef = viewChild.required<ElementRef<HTMLElement>>('top');
  private readonly questionBox = viewChild.required<ElementRef<HTMLElement>>('questionBox');
  private readonly answerBoxes = viewChildren<ElementRef<HTMLElement>>('answerBox');

  // At most one answer per fruit colour; stage 4 always has three.
  protected readonly answers = computed(() => this.question().options.slice(0, SLOTS.length));
  protected readonly slotCount = computed(() => this.answers().length);

  // The slot the player cut for this question. It doubles as the per-question lock: while it is set
  // nothing else can be chosen, and it resets by itself when the next question arrives.
  protected readonly picked = linkedSignal<QuestionView, number | null>({
    source: this.question,
    computation: () => null
  });

  // How each answer box looks: the judged answers show the right one (and the wrong choice), until
  // then the box that was cut is only outlined.
  protected readonly states = computed(() => {
    const reveal = this.reveal();
    const picked = this.picked();
    return this.answers().map((_, index) => {
      if (reveal) {
        if (reveal.correctIndex === index) {
          return 'correct';
        }
        return !reveal.correct && reveal.chosen === index ? 'wrong' : 'dim';
      }
      return picked === index ? 'picked' : '';
    });
  });

  // The how-to line at the bottom of the stage. It goes away once it has been understood (the
  // player has cut a fruit), except that a camera without a hand in view keeps asking for one.
  protected readonly hint = computed(() => {
    if (this.picked() !== null || this.reveal() !== null) {
      return '';
    }
    if (!this.cameraActive()) {
      return this.played() ? '' : 'Kéo chuột hoặc vuốt tay qua quả để chém (hoặc bấm phím 1, 2, 3)';
    }
    if (!this.handSeen()) {
      return 'Đưa ngón trỏ vào khung hình';
    }
    return this.played() ? '' : 'Vung ngón trỏ qua quả để chém';
  });

  private readonly played = signal(false);
  private readonly handSeen = signal(false);
  // The stage size, as a signal only so that the text boxes are re-fitted when it changes.
  private readonly size = signal({ width: 0, height: 0 });

  private readonly field = new FruitField();
  private readonly cursor = new HandCursor();
  private readonly trails: { pointer: TrailPoint[]; hand: TrailPoint[] } = {
    pointer: [],
    hand: []
  };
  private readonly stroke: Stroke = { id: null, last: null, length: 0 };
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;

  constructor() {
    super();
    effect(() => {
      this.question();
      untracked(() => this.startQuestion());
    });
    effect(() => {
      const reveal = this.reveal();
      untracked(() => {
        if (reveal?.correct) {
          this.field.sparkle();
        }
      });
    });
    effect(() => {
      if (!this.cameraActive()) {
        untracked(() => this.handGone());
      }
    });
    // Pausing and resuming both start from a clean slate: a stroke half-drawn when the game froze
    // must not turn into a long swipe when it resumes.
    effect(() => {
      this.paused();
      untracked(() => {
        this.clearStrokes();
        this.handGone();
      });
    });
    afterRenderEffect(() => {
      this.question();
      this.size();
      this.answerBoxes();
      this.fitText();
    });
    afterNextRender(() => this.setup());
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isTyping(event.target) ||
      !/^[1-9]$/.test(event.key)
    ) {
      return;
    }
    const slot = Number(event.key) - 1;
    if (slot < this.slotCount()) {
      this.chooseSlot(slot);
    }
  }

  override onFrame(frame: VisionFrame, now: number): void {
    if (frame.kind !== 'hand' || !this.field.ready) {
      return;
    }
    const tip = frame.hand.landmarks?.[INDEX_TIP];
    if (!tip) {
      if (this.cursor.lost(now)) {
        this.handGone();
      }
      return;
    }
    const { width, height } = this.field.metrics;
    const video = this.vision.videoSize();
    const at = mapToStage(tip.x, tip.y, video.width, video.height, width, height);
    const step = this.cursor.point(at.x, at.y, now, width, height);
    if (step.trail === 'restart') {
      this.trails.hand.length = 0;
    }
    if (step.trail) {
      this.trails.hand.push({ x: this.cursor.x, y: this.cursor.y, t: now });
    }
    this.handSeen.set(true);
    if (step.slash) {
      this.slash(step.slash);
    }
  }

  override tick(dt: number, now: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.field.ready) {
      return;
    }
    // Once the question is answered or judged no new fruit goes up; the ones in the air and the cut
    // pieces play out.
    this.field.step(dt, this.canAnswer());
    if (this.cursor.lost(now, STALE_HAND_MS)) {
      this.handGone();
    }
    this.render(ctx, now);
  }

  private canAnswer(): boolean {
    return !this.paused() && this.reveal() === null && this.picked() === null;
  }

  // The question changes under a game that stays on screen for the whole stage: the old fruits and
  // any half-drawn stroke go, the lock opens (see `picked`), and the first wave goes up at once.
  private startQuestion(): void {
    this.field.slotCount = Math.min(SLOTS.length, this.question().options.length);
    this.field.clearFruits();
    this.clearStrokes();
  }

  private clearStrokes(): void {
    this.trails.pointer.length = 0;
    this.trails.hand.length = 0;
    this.stroke.id = null;
    this.stroke.last = null;
    this.stroke.length = 0;
  }

  private handGone(): void {
    this.cursor.reset();
    this.trails.hand.length = 0;
    this.handSeen.set(false);
  }

  // A swipe segment from the fingertip or the pointer: it answers with the first fruit it crosses.
  private slash(segment: Segment): void {
    if (!this.canAnswer()) {
      return;
    }
    const fruit = this.field.slash(segment);
    if (fruit) {
      this.audio.play('slice');
      this.commit(fruit.slot);
    }
  }

  // The keyboard answer: cuts that colour's fruit if one is in view, and answers either way, so the
  // key works even in the moment between two waves.
  private chooseSlot(slot: number): void {
    if (!this.canAnswer()) {
      return;
    }
    if (this.field.sliceSlot(slot)) {
      this.audio.play('slice');
    }
    this.commit(slot);
  }

  private commit(slot: number): void {
    if (!this.canAnswer() || slot >= this.slotCount()) {
      return;
    }
    this.picked.set(slot);
    this.played.set(true);
    this.choose.emit(slot);
  }

  private render(ctx: CanvasRenderingContext2D, now: number): void {
    const { width, height } = this.field.metrics;
    const side = Math.min(width, height);
    ctx.clearRect(0, 0, width, height);
    drawField(ctx, this.field);
    drawTrail(ctx, this.trails.pointer, now, POINTER_TRAIL_RGB, side);
    drawTrail(ctx, this.trails.hand, now, HAND_TRAIL_RGB, side);
    if (this.cameraActive() && this.cursor.has && !this.paused()) {
      drawCursor(ctx, this.cursor.x, this.cursor.y, side);
    }
  }

  // Everything that needs the rendered DOM: the canvas context, the size watcher and the pointer
  // listeners. The listeners are bound by hand outside the Angular zone, because a stroke produces
  // dozens of events per second and none of them changes anything the template shows.
  private setup(): void {
    const canvas = this.canvasRef().nativeElement;
    this.ctx = canvas.getContext('2d');

    const observer = new ResizeObserver(() => this.measure());
    observer.observe(this.host);
    this.destroyRef.onDestroy(() => observer.disconnect());

    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (motion) {
      const apply = () => (this.field.effects = motion.matches ? REDUCED_EFFECTS : 1);
      apply();
      motion.addEventListener('change', apply);
      this.destroyRef.onDestroy(() => motion.removeEventListener('change', apply));
    }

    this.zone.runOutsideAngular(() => {
      canvas.addEventListener('pointerdown', event => this.pointerDown(event, canvas));
      canvas.addEventListener('pointermove', event => this.pointerMove(event, canvas));
      const end = (event: PointerEvent) => {
        if (event.pointerId === this.stroke.id) {
          this.stroke.id = null;
          this.stroke.last = null;
          this.stroke.length = 0;
        }
      };
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
      canvas.addEventListener('lostpointercapture', end);
    });
    this.measure();
  }

  // Sizes the canvas to the host at the device's pixel ratio (capped at 2, where the extra detail
  // stops being visible and only costs fill rate) and tells the field where the play area is.
  private measure(): void {
    const width = Math.round(this.host.clientWidth);
    const height = Math.round(this.host.clientHeight);
    if (width < 1 || height < 1) {
      return;
    }
    const canvas = this.canvasRef().nativeElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const previous = this.field.metrics;
    const resized = width !== previous.width || height !== previous.height;
    if (resized || dpr !== this.dpr) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      // Resizing the bitmap resets the transform, so the pixel-ratio scale is applied again.
      this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.dpr = dpr;
    }
    const hostTop = this.host.getBoundingClientRect().top;
    const topBottom = this.topRef().nativeElement.getBoundingClientRect().bottom;
    this.field.resize(width, height, Math.max(60, topBottom - hostTop + 8));
    if (resized) {
      this.clearStrokes();
      this.size.set({ width, height });
    }
  }

  private pointerDown(event: PointerEvent, canvas: HTMLCanvasElement): void {
    this.audio.resume();
    if (
      (event.pointerType === 'mouse' && event.button !== 0) ||
      this.stroke.id !== null ||
      !this.canAnswer()
    ) {
      return;
    }
    this.stroke.id = event.pointerId;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that has already ended cannot be captured; the stroke still works on the canvas.
    }
    const rect = canvas.getBoundingClientRect();
    const start = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.stroke.last = start;
    this.stroke.length = 0;
    this.trails.pointer.length = 0;
    this.trails.pointer.push({ ...start, t: performance.now() });
    event.preventDefault();
  }

  private pointerMove(event: PointerEvent, canvas: HTMLCanvasElement): void {
    if (event.pointerId !== this.stroke.id || !this.stroke.last || !this.canAnswer()) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    // A fast stroke delivers several positions per event; using them all keeps the segments short
    // enough that the trail is smooth and a thin fruit cannot slip between two samples.
    const samples =
      typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    for (const sample of samples.length ? samples : [event]) {
      const to = { x: sample.clientX - rect.left, y: sample.clientY - rect.top };
      const from = this.stroke.last;
      const moved = Math.hypot(to.x - from.x, to.y - from.y);
      if (moved < 0.5) {
        continue;
      }
      this.stroke.length += moved;
      this.trails.pointer.push({ ...to, t: performance.now() });
      if (this.stroke.length >= MIN_STROKE_PX) {
        this.slash({ ax: from.x, ay: from.y, bx: to.x, by: to.y });
      }
      this.stroke.last = to;
    }
    event.preventDefault();
  }

  // Fits the question and the three answers into their boxes. The answers share one size (the
  // smallest that fits them all) so the colours read as a set instead of one box shouting.
  private fitText(): void {
    const question = this.questionBox().nativeElement;
    const questionText = question.querySelector<HTMLElement>('.fit');
    if (questionText) {
      fitSize(
        question,
        questionText,
        Math.min(question.clientHeight * 0.7, question.clientWidth * 0.5, 96)
      );
    }
    const fitted: { span: HTMLElement; size: number }[] = [];
    for (const ref of this.answerBoxes()) {
      const box = ref.nativeElement;
      const span = box.querySelector<HTMLElement>('.fit');
      if (span) {
        const start = Math.min(box.clientHeight * 0.62, box.clientWidth * 0.7, 84);
        fitted.push({ span, size: fitSize(box, span, start) });
      }
    }
    const smallest = Math.min(...fitted.map(item => item.size));
    for (const { span } of fitted) {
      span.style.fontSize = `${smallest}px`;
    }
  }
}
