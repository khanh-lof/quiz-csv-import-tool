import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  NgZone,
  OnDestroy,
  OnInit,
  signal,
  computed,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzSpinComponent } from 'ng-zorro-antd/spin';
import { DEMO_QUIZ_CSV, DEMO_QUIZ_TITLE } from '../../game/demo-quiz';
import { GameAudio } from '../../game/game-audio';
import { Choice, Reveal, StageGameBase, VisionFrame, VisionKind } from '../../game/stage-game';
import { passMark, STAGES, stageDef } from '../../game/stages';
import { VisionService } from '../../game/vision.service';
import { AiJob } from '../../models/ai-job';
import { ExportType } from '../../models/export-type';
import { GestureQuiz, parseGestureQuiz, questionCount } from '../../models/gesture-quiz';
import { AiCsvService } from '../../services/ai-csv.service';
import { AiJobService } from '../../services/ai-job.service';
import { CsvImportService } from '../../services/csv-import.service';
import { GestureProgressService, POINTS_PER_CORRECT } from '../../services/gesture-progress.service';
import { UsageGuide } from '../usage-guide/usage-guide';
import {
  correctAnswerText,
  judge,
  PlayQuestion,
  prepareQuestion,
  shuffled,
  timeLimitFor,
  timeoutReveal,
  titleFromFileName,
} from './gesture-engine';
import { GestureSettingsService } from './gesture-settings.service';
import { FingerCountGame } from './games/finger-count-game/finger-count-game';
import { FrogBiteGame } from './games/frog-bite-game/frog-bite-game';
import { FruitSliceGame } from './games/fruit-slice-game/fruit-slice-game';
import { HeadTiltGame } from './games/head-tilt-game/head-tilt-game';
import { TrueFalseGame } from './games/true-false-game/true-false-game';
import { WordOrderGame } from './games/word-order-game/word-order-game';
import { GestureStageMap } from './stage-map/stage-map';
import { GestureStageResult, MissedQuestion, StageRunResult } from './stage-result/stage-result';

type Screen = 'loading' | 'error' | 'load' | 'map' | 'intro' | 'playing' | 'result';

// What the camera sees of the player, for the status chip: 'seen' (the hand or face is in view), 'lost'
// (nothing there) and 'multi' (more than one face, which the face games cannot use).
type Tracking = 'seen' | 'lost' | 'multi';

interface Chip {
  text: string;
  tone: 'ok' | 'wait' | 'bad' | 'off';
}

// After a judged answer the page moves on by itself: a wrong one stays longer so the explanation can
// be read.
const ADVANCE_AFTER_CORRECT_S = 2.5;
const ADVANCE_AFTER_WRONG_S = 4;
// The last seconds of a question tick, to warn the player.
const TICK_SECONDS = 3;
// A frame without a hand or face is not "lost" at once: tracking blinks for a moment now and then.
const TRACKING_GRACE_MS = 500;
// A frame that took longer than this (a background tab, a debugger) must not eat a whole question's time.
const MAX_FRAME_DT_S = 0.1;

// A file saved by Excel starts with this mark; it would stick to the first cell and hide the header row.
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

const STAND_TIP: Record<VisionKind, string> = {
  hand: 'Đứng cách webcam khoảng 0,6–1,2 m, để tay trong khung hình và có ánh sáng chiếu vào phía trước (đừng đứng ngược sáng).',
  face: 'Ngồi hoặc đứng cách webcam khoảng 0,6–1,2 m, nhìn thẳng vào camera, có ánh sáng chiếu vào mặt và chỉ một người trong khung hình.',
};

// The gesture quiz page, played full screen outside the workspace frame. It loads a quiz (from an AI job
// or a CSV file, or the built-in sample), shows the six stages as a map, and runs one stage at a time:
// the page owns the questions, the timer, the camera and the scoring, and the stage's game component
// only turns the player's gestures (or mouse and keyboard) into a choice. MediaPipe is loaded through
// VisionService only when the camera is turned on, so this whole page is a lazy chunk.
@Component({
  selector: 'app-gesture-play',
  imports: [
    RouterLink,
    NzButtonComponent,
    NzIconDirective,
    NzSpinComponent,
    UsageGuide,
    GestureStageMap,
    GestureStageResult,
    TrueFalseGame,
    HeadTiltGame,
    FrogBiteGame,
    FruitSliceGame,
    FingerCountGame,
    WordOrderGame,
  ],
  templateUrl: './gesture-play.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './gesture-play.css'
})
export class GesturePlay implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly zone = inject(NgZone);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly notificationService = inject(NzNotificationService);
  private readonly jobService = inject(AiJobService);
  private readonly aiCsvService = inject(AiCsvService);
  private readonly csvImportService = inject(CsvImportService);
  private readonly progress = inject(GestureProgressService);
  private readonly settingsService = inject(GestureSettingsService);
  private readonly vision = inject(VisionService);
  private readonly audio = inject(GameAudio);

  protected readonly screen = signal<Screen>('loading');
  // The AI job being played, when the page was opened from the jobs table ("Chơi ngay").
  protected readonly jobId = signal<string | null>(null);
  protected readonly quiz = signal<GestureQuiz | null>(null);
  // Why a quiz could not be opened: shown on the load screen, or in the error card for a job.
  protected readonly problem = signal('');

  protected readonly settings = this.settingsService.settings;

  protected readonly stage = signal(1);
  protected readonly def = computed(() => stageDef(this.stage()));
  protected readonly stageQuestionCount = computed(() => this.quiz()?.stages.get(this.stage())?.length ?? 0);
  protected readonly stageTimeLimit = computed(() =>
    timeLimitFor(this.def().seconds, this.settings().timeMode));
  protected readonly passMarkOf = passMark;
  protected readonly standTip = computed(() => STAND_TIP[this.def().vision]);

  // One run of a stage.
  protected readonly questions = signal<PlayQuestion[]>([]);
  protected readonly index = signal(0);
  protected readonly score = signal(0);
  protected readonly streak = signal(0);
  protected readonly reveal = signal<Reveal | null>(null);
  protected readonly paused = signal(false);
  // The whole seconds left on this question (null without a time limit): written only when the second
  // changes, so the page is not redrawn on every frame.
  protected readonly secondsLeft = signal<number | null>(null);
  protected readonly result = signal<StageRunResult | null>(null);

  protected readonly current = computed(() => this.questions()[this.index()] ?? null);
  protected readonly view = computed(() => this.current()?.view ?? null);
  protected readonly totalQuestions = computed(() => this.questions().length);
  protected readonly correctText = computed(() => {
    const play = this.current();
    return play ? correctAnswerText(play) : '';
  });
  protected readonly verdict = computed(() => {
    const reveal = this.reveal();
    if (!reveal) {
      return null;
    }
    if (reveal.chosen === null) {
      return { kind: 'wrong', text: '⏱ Hết giờ' };
    }
    return reveal.correct
      ? { kind: 'correct', text: `✓ Chính xác! +${POINTS_PER_CORRECT}` }
      : { kind: 'wrong', text: '✗ Chưa đúng' };
  });

  // The camera, and whether this stage's model is ready: only then do gestures reach the game.
  protected readonly cameraState = this.vision.cameraState;
  protected readonly cameraOn = computed(() => this.cameraState() === 'on');
  protected readonly modelState = computed(() => this.vision.modelState(this.def().vision)());
  protected readonly cameraActive = computed(() => this.cameraOn() && this.modelState() === 'ready');
  protected readonly tracking = signal<Tracking>('lost');
  protected readonly fullscreen = signal(false);

  protected readonly cameraChip = computed<Chip>(() => {
    switch (this.cameraState()) {
      case 'on':
        return { text: 'Camera bật', tone: 'ok' };
      case 'starting':
        return { text: 'Đang bật camera…', tone: 'wait' };
      case 'off':
        return { text: 'Camera tắt', tone: 'off' };
      default:
        return { text: 'Không dùng được camera', tone: 'bad' };
    }
  });
  // The recognition model's state, only while there is a camera for it to read.
  protected readonly modelChip = computed<Chip | null>(() => {
    if (this.cameraState() !== 'on' && this.cameraState() !== 'starting') {
      return null;
    }
    switch (this.modelState()) {
      case 'loading':
        return { text: 'Đang tải nhận diện…', tone: 'wait' };
      case 'ready':
        return { text: 'Nhận diện sẵn sàng', tone: 'ok' };
      case 'error':
        return { text: 'Chưa tải được nhận diện', tone: 'bad' };
      default:
        return null;
    }
  });
  protected readonly trackingChip = computed<Chip | null>(() => {
    if (!this.cameraActive()) {
      return null;
    }
    const hand = this.def().vision === 'hand';
    switch (this.tracking()) {
      case 'seen':
        return { text: hand ? 'Đã thấy tay ✓' : 'Đã thấy mặt ✓', tone: 'ok' };
      case 'multi':
        return { text: 'Chỉ một người trước camera', tone: 'bad' };
      default:
        return { text: hand ? 'Đưa tay vào khung hình' : 'Chưa thấy mặt', tone: 'wait' };
    }
  });
  // Why the camera or recognition is not working, in words the player can act on.
  protected readonly cameraNotice = computed(() => {
    const message = this.vision.cameraMessage();
    if (message) {
      return message;
    }
    return this.cameraOn() && this.modelState() === 'error'
      ? 'Không tải được bộ nhận diện cử chỉ. Bạn vẫn chơi được bằng chuột và bàn phím.'
      : '';
  });

  private readonly game = viewChild(StageGameBase);
  // Where `vision.video` is shown: the stage while playing, the small preview on the intro screen.
  private readonly stageElement = viewChild<ElementRef<HTMLElement>>('stageBox');
  private readonly previewElement = viewChild<ElementRef<HTMLElement>>('preview');

  // The loop's own clock and the current question's, kept out of signals: they change every frame.
  private frameHandle = 0;
  private lastFrameAt = 0;
  private remaining = 0;
  private limit: number | null = null;
  private revealedFor = 0;
  private lastSeenAt = Number.NEGATIVE_INFINITY;

  // What the run adds up to, for the result screen.
  private correctCount = 0;
  private bestStreak = 0;
  private missed: MissedQuestion[] = [];

  constructor() {
    // Puts the camera picture behind the game. It is a single element owned by VisionService, so it is
    // moved here rather than created by the template. Taking a video out of the page pauses it and a live
    // stream does not resume on its own, so it is started again each time it is put back.
    effect(() => {
      const host = (this.stageElement() ?? this.previewElement())?.nativeElement ?? null;
      const on = this.cameraOn();
      untracked(() => {
        const video = this.vision.video;
        if (host && on) {
          if (video.parentElement !== host) {
            host.prepend(video);
          }
          if (video.paused) {
            video.play().catch(() => undefined);
          }
        } else if (video.parentElement) {
          video.remove();
        }
      });
    });
  }

  ngOnInit(): void {
    // The route's parameter can change under this same component (one job to another), so it is watched
    // rather than read once.
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      const id = params.get('jobId');
      this.resetRun();
      this.jobId.set(id);
      this.quiz.set(null);
      if (id) {
        this.loadJob(id);
      } else {
        this.problem.set('');
        this.screen.set('load');
      }
    });
    this.startLoop();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameHandle);
    this.vision.stopCamera();
    this.vision.video.remove();
    if (document.fullscreenElement === this.host.nativeElement) {
      document.exitFullscreen().catch(() => undefined);
    }
  }

  // ---- Loading a quiz ----

  private loadJob(id: string): void {
    this.screen.set('loading');
    const find = () => this.jobService.jobs().find(job => job.id === id);
    const known = find();
    if (known) {
      this.openJob(known);
      return;
    }
    // The table's list is empty when the page was opened directly (or the job is new): ask once.
    this.jobService.refresh().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.openJob(find()),
      error: () => this.fail('Không tải được quiz từ máy chủ. Hãy kiểm tra kết nối rồi thử lại.'),
    });
  }

  private openJob(job: AiJob | undefined): void {
    if (!job) {
      this.fail('Không tìm thấy quiz này. Có thể nó đã bị xóa khỏi bảng lịch sử.');
    } else if (job.status === 'running') {
      this.fail('AI vẫn đang tạo quiz này. Hãy quay lại bảng lịch sử và thử lại khi nó xong.');
    } else if (job.status !== 'done') {
      this.fail('Lần tạo này không thành công nên chưa có quiz để chơi.');
    } else if (job.exportType !== ExportType.GestureQuiz) {
      this.fail('Đây không phải quiz cử chỉ. Hãy chọn nền tảng "Quiz cử chỉ" khi nhờ AI tạo.');
    } else {
      this.openCsv(this.aiCsvService.extractCsvContent(job.csv), job.title);
    }
  }

  protected onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Cleared so that picking the same file again still raises a change.
    input.value = '';
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => this.openCsv(String(reader.result ?? ''), titleFromFileName(file.name));
    reader.onerror = () => this.fail('Không đọc được file này. Hãy thử lại hoặc chọn file khác.');
    reader.readAsText(file);
  }

  protected playDemo(): void {
    this.audio.resume();
    this.openCsv(DEMO_QUIZ_CSV, DEMO_QUIZ_TITLE);
  }

  private openCsv(text: string, title: string): void {
    const rows = this.csvImportService.parseCsvRows(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
    const quiz = parseGestureQuiz(rows, title);
    if (questionCount(quiz) === 0) {
      this.fail('Không tìm thấy câu hỏi hợp lệ trong quiz này. Hãy dùng file Quiz cử chỉ do AI tạo (tab "Tạo bằng AI").');
      return;
    }
    if (quiz.skipped > 0) {
      this.notificationService.warning(
        'Có dòng không dùng được',
        `Đã bỏ qua ${quiz.skipped} dòng không hợp lệ trong quiz.`,
        { nzPlacement: 'top' });
    }
    this.resetRun();
    this.problem.set('');
    this.quiz.set(quiz);
    this.screen.set('map');
  }

  // A quiz opened from a job has no load screen to go back to, so its problems get their own card.
  private fail(message: string): void {
    this.problem.set(message);
    this.screen.set(this.jobId() ? 'error' : 'load');
  }

  // ---- Moving between the screens ----

  protected openIntro(stage: number): void {
    const quiz = this.quiz();
    if (!quiz || !quiz.stages.has(stage) || !this.progress.isUnlocked(quiz, stage)) {
      return;
    }
    this.stage.set(stage);
    this.screen.set('intro');
    this.prepareVision();
  }

  protected begin(): void {
    // A user gesture, which is what lets the browser start the sound.
    this.audio.resume();
    this.audio.play('start');
    this.startRun();
  }

  protected backToMap(): void {
    this.resetRun();
    // The camera is only needed while a stage is being set up or played.
    this.vision.stopCamera();
    this.screen.set('map');
  }

  // Another quiz from a file: only for a quiz that was opened on this page, not for a job's.
  protected openAnother(): void {
    this.resetRun();
    this.vision.stopCamera();
    this.quiz.set(null);
    this.problem.set('');
    this.screen.set('load');
  }

  protected openNextStage(): void {
    const next = this.nextStageWithQuestions(this.stage());
    if (next === null) {
      this.backToMap();
    } else {
      this.openIntro(next);
    }
  }

  protected retryStage(): void {
    this.audio.resume();
    this.startRun();
  }

  private nextStageWithQuestions(stage: number): number | null {
    const quiz = this.quiz();
    return STAGES.find(def => def.stage > stage && quiz?.stages.has(def.stage))?.stage ?? null;
  }

  // ---- Playing a stage ----

  private startRun(): void {
    const quiz = this.quiz();
    if (!quiz) {
      return;
    }
    const def = this.def();
    // Every run asks the stage's questions in a new order.
    this.questions.set(shuffled(quiz.stages.get(def.stage) ?? []).map(prepareQuestion));
    this.index.set(0);
    this.score.set(0);
    this.streak.set(0);
    this.reveal.set(null);
    this.paused.set(false);
    this.tracking.set('lost');
    this.lastSeenAt = Number.NEGATIVE_INFINITY;
    this.correctCount = 0;
    this.bestStreak = 0;
    this.missed = [];
    this.limit = this.stageTimeLimit();
    this.startQuestionTimer();
    this.screen.set('playing');
    this.prepareVision();
  }

  // Back to a state where nothing is being played, so a stale run can never be seen or judged.
  private resetRun(): void {
    this.questions.set([]);
    this.index.set(0);
    this.reveal.set(null);
    this.paused.set(false);
    this.secondsLeft.set(null);
    this.result.set(null);
  }

  private startQuestionTimer(): void {
    this.remaining = this.limit ?? 0;
    this.secondsLeft.set(this.limit);
  }

  // Called by the game with the player's choice, possibly from the animation loop outside Angular.
  protected onChoose(choice: Choice): void {
    this.inZone(() => {
      const play = this.current();
      if (!play || this.screen() !== 'playing' || this.paused() || this.reveal() !== null) {
        return;
      }
      this.showReveal(play, judge(play, choice));
    });
  }

  private timeUp(): void {
    this.inZone(() => {
      const play = this.current();
      if (play && this.reveal() === null) {
        this.showReveal(play, timeoutReveal(play));
      }
    });
  }

  private showReveal(play: PlayQuestion, reveal: Reveal): void {
    this.reveal.set(reveal);
    this.revealedFor = 0;
    if (reveal.correct) {
      this.score.update(score => score + POINTS_PER_CORRECT);
      this.streak.update(streak => streak + 1);
      this.correctCount += 1;
      this.bestStreak = Math.max(this.bestStreak, this.streak());
      this.audio.play('correct', this.streak());
      return;
    }
    this.streak.set(0);
    this.audio.play(reveal.chosen === null ? 'timeout' : 'wrong');
    this.missed.push({
      question: play.source.question,
      answer: correctAnswerText(play),
      explanation: play.source.explanation,
      timedOut: reveal.chosen === null,
    });
  }

  // "Tiếp": on to the next question, or the result after the last one.
  protected next(): void {
    this.inZone(() => {
      if (this.reveal() === null || this.screen() !== 'playing') {
        return;
      }
      if (this.index() + 1 >= this.questions().length) {
        this.finishRun();
        return;
      }
      this.reveal.set(null);
      this.index.update(index => index + 1);
      this.startQuestionTimer();
    });
  }

  private finishRun(): void {
    const quiz = this.quiz();
    if (!quiz) {
      return;
    }
    const total = this.questions().length;
    const stage = this.stage();
    const passed = this.progress.record(quiz.key, stage, this.correctCount, total);
    this.result.set({
      stage,
      correct: this.correctCount,
      total,
      points: this.score(),
      passMark: passMark(total),
      passed,
      bestStreak: this.bestStreak,
      missed: this.missed,
      hasNext: passed && this.nextStageWithQuestions(stage) !== null,
    });
    this.reveal.set(null);
    this.audio.play(passed ? 'finish' : 'wrong');
    this.screen.set('result');
  }

  protected togglePause(): void {
    if (this.screen() === 'playing') {
      this.paused.update(paused => !paused);
    }
  }

  protected toggleSound(): void {
    this.settingsService.update({ sound: !this.settings().sound });
  }

  // ---- The animation loop ----

  private startLoop(): void {
    // Outside Angular's zone, so a frame every 16 ms does not run change detection each time; whatever
    // a frame changes on screen goes through a signal (or `inZone` when the whole page must be checked).
    this.zone.runOutsideAngular(() => {
      const step = (now: number) => {
        this.frameHandle = requestAnimationFrame(step);
        this.frame(now);
      };
      this.frameHandle = requestAnimationFrame(step);
    });
  }

  private frame(now: number): void {
    const dt = this.lastFrameAt === 0 ? 0 : Math.min((now - this.lastFrameAt) / 1000, MAX_FRAME_DT_S);
    this.lastFrameAt = now;
    if (this.screen() !== 'playing' || this.paused()) {
      return;
    }
    const game = this.game();
    if (!game) {
      return;
    }

    if (this.cameraActive()) {
      const frame = this.vision.detect(this.def().vision, now);
      if (frame) {
        this.track(frame, now);
        game.onFrame(frame, now);
      }
    }
    game.tick(dt, now);

    if (this.reveal() !== null) {
      this.revealedFor += dt;
      const wait = this.reveal()?.correct ? ADVANCE_AFTER_CORRECT_S : ADVANCE_AFTER_WRONG_S;
      if (this.revealedFor >= wait) {
        this.next();
      }
    } else if (game.ready()) {
      this.runTimer(dt);
    }
  }

  // The question's clock: it only runs while the player can answer (nothing judged yet, and a face
  // game's calibration finished) and a time limit is on.
  private runTimer(dt: number): void {
    if (this.limit === null) {
      return;
    }
    this.remaining = Math.max(0, this.remaining - dt);
    const whole = Math.ceil(this.remaining);
    if (whole !== this.secondsLeft()) {
      this.inZone(() => this.secondsLeft.set(whole));
      if (whole > 0 && whole <= TICK_SECONDS) {
        this.audio.play('tick');
      }
    }
    if (this.remaining <= 0) {
      this.timeUp();
    }
  }

  // Keeps the status chip in step with what the camera finds.
  private track(frame: VisionFrame, now: number): void {
    let seen: Tracking;
    if (frame.kind === 'hand') {
      seen = frame.hand.landmarks ? 'seen' : 'lost';
    } else if (frame.face.faces > 1) {
      seen = 'multi';
    } else {
      seen = frame.face.landmarks ? 'seen' : 'lost';
    }
    if (seen !== 'lost') {
      this.lastSeenAt = now;
    }
    const next = seen === 'lost' && now - this.lastSeenAt <= TRACKING_GRACE_MS ? this.tracking() : seen;
    if (next !== this.tracking()) {
      this.inZone(() => this.tracking.set(next));
    }
  }

  // Runs `action` inside Angular's zone, so the page is checked afterwards even when the caller is the
  // animation loop or a game that was driven from it.
  private inZone(action: () => void): void {
    if (NgZone.isInAngularZone()) {
      action();
    } else {
      this.zone.run(action);
    }
  }

  // ---- Camera ----

  protected toggleCamera(): void {
    const state = this.vision.cameraState();
    if (state === 'on' || state === 'starting') {
      this.vision.stopCamera();
      this.settingsService.update({ useCamera: false });
      return;
    }
    void this.enableCamera();
  }

  private async enableCamera(): Promise<void> {
    this.audio.resume();
    this.settingsService.update({ useCamera: true });
    // The model downloads while the browser asks for permission, so neither waits for the other.
    await Promise.all([this.loadModel(this.def().vision), this.vision.startCamera()]);
    this.preloadOtherModels();
    const state = this.vision.cameraState();
    // A camera that could not be started is not asked for again on every visit; the player turns it on
    // by hand once the problem (permission, another app) is fixed.
    if (state !== 'on' && state !== 'starting') {
      this.settingsService.update({ useCamera: false });
    }
  }

  // What a stage needs from the camera when it is opened: start it if the player had it on last time,
  // and make sure this stage's model (hand or face) is loaded.
  private prepareVision(): void {
    const state = this.vision.cameraState();
    if (state === 'on' || state === 'starting') {
      void this.loadModel(this.def().vision);
    } else if (state === 'off' && this.settings().useCamera) {
      void this.enableCamera();
    }
  }

  protected retryModel(): void {
    void this.loadModel(this.def().vision);
  }

  // A failed load is shown by the model chip and the notice; the quiz stays playable without it.
  private loadModel(kind: VisionKind): Promise<void> {
    return this.vision.ensureModel(kind).then(() => this.preloadOtherModels()).catch(() => undefined);
  }

  // Once this stage's model is ready and the camera is on, the other kind the quiz needs is fetched in
  // the background so changing stage does not wait for it. Never while playing: creating a model can
  // stall the page for a moment.
  private preloadOtherModels(): void {
    const quiz = this.quiz();
    const ready = this.vision.modelState(this.def().vision)() === 'ready';
    if (!quiz || !ready || !this.cameraOn() || this.screen() === 'playing') {
      return;
    }
    const wanted = new Set(STAGES.filter(def => quiz.stages.has(def.stage)).map(def => def.vision));
    for (const kind of wanted) {
      if (this.vision.modelState(kind)() === 'idle') {
        this.vision.ensureModel(kind).catch(() => undefined);
      }
    }
  }

  // ---- Keyboard, visibility and fullscreen ----

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (this.screen() !== 'playing' || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    // Typing in a field is not a command.
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) {
      return;
    }
    if (event.key === 'p' || event.key === 'P') {
      event.preventDefault();
      if (!event.repeat) {
        this.togglePause();
      }
    } else if (event.key === 'Enter' && this.reveal() !== null && !this.paused()) {
      // Prevented so that a focused button does not also click itself. A held key must not skip a
      // question after the next one.
      event.preventDefault();
      if (!event.repeat) {
        this.next();
      }
    }
  }

  // A hidden tab stops the animation frames anyway; pausing makes the player come back to a stopped
  // question instead of a timed-out one.
  @HostListener('document:visibilitychange')
  protected onVisibilityChange(): void {
    if (document.hidden && this.screen() === 'playing') {
      this.paused.set(true);
    }
  }

  @HostListener('document:fullscreenchange')
  protected onFullscreenChange(): void {
    this.fullscreen.set(document.fullscreenElement !== null);
  }

  protected toggleFullscreen(): void {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
      return;
    }
    const failed = () => this.notificationService.warning(
      'Không bật được toàn màn hình',
      'Trình duyệt không cho phép chế độ toàn màn hình ở đây.',
      { nzPlacement: 'top' });
    try {
      this.host.nativeElement.requestFullscreen().catch(failed);
    } catch {
      failed();
    }
  }
}
