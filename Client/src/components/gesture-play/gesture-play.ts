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
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzSpinComponent } from 'ng-zorro-antd/spin';
import { Observable, Observer, Subscription, timeout } from 'rxjs';
import { DEMO_QUIZ_CSV, DEMO_QUIZ_TITLE } from '../../game/demo-quiz';
import { GameAudio } from '../../game/game-audio';
import { Choice, Reveal, StageGameBase, VisionFrame, VisionKind } from '../../game/stage-game';
import { passMark, STAGES, stageDef, stagePosition } from '../../game/stages';
import { VisionService } from '../../game/vision.service';
import { AiJob } from '../../models/ai-job';
import { attemptsLeft, formatClose, passPercentOf, PlayerIdentity, SharedQuiz, StageLock } from '../../models/assignment';
import { avatarDef, randomAvatar } from '../../models/avatar';
import { ExportType } from '../../models/export-type';
import { GestureQuiz, parseGestureQuiz, questionCount } from '../../models/gesture-quiz';
import { AiCsvService } from '../../services/ai-csv.service';
import { AiJobService } from '../../services/ai-job.service';
import { AssignmentService } from '../../services/assignment.service';
import { CsvImportService } from '../../services/csv-import.service';
import { GestureProgressService, POINTS_PER_CORRECT } from '../../services/gesture-progress.service';
import { SharedPlayService } from '../../services/shared-play.service';
import { AvatarPicker } from '../leaderboard/avatar-picker/avatar-picker';
import { MarqueeText } from '../leaderboard/marquee-text/marquee-text';
import { PlayerAvatar } from '../leaderboard/player-avatar/player-avatar';
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
import { GestureSettingsService, TimeMode } from './gesture-settings.service';
import { FingerCountGame } from './games/finger-count-game/finger-count-game';
import { FrogBiteGame } from './games/frog-bite-game/frog-bite-game';
import { FruitSliceGame } from './games/fruit-slice-game/fruit-slice-game';
import { HeadTiltGame } from './games/head-tilt-game/head-tilt-game';
import { TrueFalseGame } from './games/true-false-game/true-false-game';
import { WordOrderGame } from './games/word-order-game/word-order-game';
import { GestureStageMap } from './stage-map/stage-map';
import { JoinRequest, ShareJoin } from './share-join/share-join';
import { StudentLeaderboard } from './student-leaderboard/student-leaderboard';
import { GestureStageResult, MissedQuestion, SaveState, StageRunResult } from './stage-result/stage-result';

// 'join' is a student's first screen on a shared quiz: the name to play under.
type Screen = 'loading' | 'error' | 'join' | 'load' | 'map' | 'intro' | 'playing' | 'result';

// How the page was opened, from the route's parameters: a file or the sample ('local'), one of the
// signed-in user's AI jobs ('job'), a quiz a teacher gave out as an assignment ('shared': a student on
// /play/s/:code) or the teacher trying that assignment out ('preview').
type Mode = 'local' | 'job' | 'shared' | 'preview';

// A link out of the page: the topbar's, and the error card's button, which lead back into the app.
interface PageLink {
  url: string;
  text: string;
}

// What a shared quiz says about itself besides the quiz: the class label and when it closes.
interface SharedInfo {
  label: string;
  closesAt: string | null;
}

const SHARED_CLOSED = 'Bài này đã đóng. Cảm ơn bạn đã tham gia!';
const SHARED_MISSING = 'Không tìm thấy bài này. Hãy kiểm tra lại link thầy cô gửi.';
const SHARED_FAILED = 'Không tải được bài. Hãy kiểm tra mạng rồi tải lại trang.';

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

// The check before a shared stage only guards against a closed assignment: a connection too slow to answer
// in this time must not keep the student from playing (the results are queued if they cannot be sent).
const STAGE_CHECK_TIMEOUT_MS = 4000;

// A file saved by Excel starts with this mark; it would stick to the first cell and hide the header row.
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

const STAND_TIP: Record<VisionKind, string> = {
  hand: 'Đứng cách webcam 0,6–1,2 m, tay trong khung hình, đủ sáng (đừng ngược sáng).',
  face: 'Cách webcam 0,6–1,2 m, nhìn thẳng, mặt đủ sáng, chỉ một người trong khung hình.',
};

// The gesture quiz page, played full screen outside the workspace frame. It loads a quiz (from an AI job
// or a CSV file, or the built-in sample; or a teacher's assignment, for a student and as the teacher's
// preview), shows the stages it has (1 to 6 of the six) as a map, and runs one stage at a time:
// the page owns the questions, the timer, the camera and the scoring, and the stage's game component
// only turns the player's gestures (or mouse and keyboard) into a choice. MediaPipe is loaded through
// VisionService only when the camera is turned on, so this whole page is a lazy chunk.
@Component({
  selector: 'app-gesture-play',
  imports: [
    RouterLink,
    NzButtonComponent,
    NzIconDirective,
    NzModalModule,
    NzSpinComponent,
    AvatarPicker,
    MarqueeText,
    PlayerAvatar,
    UsageGuide,
    GestureStageMap,
    GestureStageResult,
    ShareJoin,
    StudentLeaderboard,
    TrueFalseGame,
    HeadTiltGame,
    FrogBiteGame,
    FruitSliceGame,
    FingerCountGame,
    WordOrderGame,
  ],
  templateUrl: './gesture-play.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./gesture-play.css', './game-themes.css', './play-themes.css']
})
export class GesturePlay implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly zone = inject(NgZone);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly notificationService = inject(NzNotificationService);
  private readonly jobService = inject(AiJobService);
  private readonly assignmentService = inject(AssignmentService);
  private readonly sharedPlay = inject(SharedPlayService);
  private readonly aiCsvService = inject(AiCsvService);
  private readonly csvImportService = inject(CsvImportService);
  private readonly progress = inject(GestureProgressService);
  private readonly settingsService = inject(GestureSettingsService);
  private readonly vision = inject(VisionService);
  private readonly audio = inject(GameAudio);

  protected readonly screen = signal<Screen>('loading');
  protected readonly mode = signal<Mode>('local');
  // The AI job being played, when the page was opened from the jobs table ("Chơi ngay").
  protected readonly jobId = signal<string | null>(null);
  // The assignment being previewed (the teacher), and the code of the shared quiz, upper-cased (a student).
  protected readonly assignmentId = signal<string | null>(null);
  protected readonly shareCode = signal('');
  // The code of the assignment being previewed: the board under its map is read by it, as a student's is.
  private readonly previewCode = signal('');
  // The quiz as it was loaded, and the student playing it. What is played (`quiz`) is the same quiz under
  // a key of its own for that student, so GestureProgressService keeps each student's locks and bests
  // apart from other students' and from the same quiz played as a file or a job.
  private readonly baseQuiz = signal<GestureQuiz | null>(null);
  private readonly player = signal<PlayerIdentity | null>(null);
  protected readonly quiz = computed<GestureQuiz | null>(() => {
    const base = this.baseQuiz();
    const player = this.player();
    return base && player && this.mode() === 'shared'
      ? { ...base, key: `asg:${this.shareCode()}:${player.playerId}` }
      : base;
  });
  protected readonly playerName = computed(() => this.player()?.name ?? '');
  protected readonly playerAvatar = computed(() => this.player()?.avatar ?? '');
  protected readonly shared = signal<SharedInfo | null>(null);
  protected readonly closeText = computed(() => {
    const closesAt = this.shared()?.closesAt;
    return closesAt ? formatClose(closesAt) : '';
  });
  // What the topbar names: the quiz and, for a shared one, its class label after it.
  protected readonly heading = computed(() => {
    const title = this.quiz()?.title ?? 'Game';
    const label = this.shared()?.label;
    return label ? `${title} · ${label}` : title;
  });
  // The topbar's way out of the page. A student has none: the quiz is all they were sent to.
  protected readonly backLink = computed<PageLink | null>(() => {
    switch (this.mode()) {
      case 'job':
        return { url: '/ai-history', text: 'Về lịch sử AI' };
      case 'preview':
        return { url: `/assignments/${encodeURIComponent(this.assignmentId() ?? '')}`, text: 'Về bảng xếp hạng' };
      case 'local':
        return { url: '/quiz', text: 'Về bảng quiz' };
      default:
        return null;
    }
  });
  // The teacher's time mode, which replaces the player's own setting for an assignment.
  protected readonly assignmentTimeMode = signal<TimeMode | null>(null);
  // The teacher's stage lock: `open` lets the student play any stage from the start.
  protected readonly assignmentStageLock = signal<StageLock | null>(null);
  // The teacher's choice to show the board to students. Null while unknown, which is the closed card of a link
  // that was already closed when opened (GET share/{code} answered 410, so the page never learnt it): the
  // board component then copes with the server's 404 `Board hidden` itself.
  protected readonly assignmentShowBoard = signal<boolean | null>(null);
  // The teacher's pass percentage of each stage ("1" to "6"); null outside an assignment, where it is the default.
  protected readonly assignmentPassPercents = signal<Record<string, number> | null>(null);
  // The teacher's limit on the runs of each stage (an assignment with the open lock), null for none, and the
  // runs this student has used of each stage ("1" to "6"): the server's count, plus what this device played
  // since and has not been counted yet. Only a shared quiz is ever limited.
  protected readonly assignmentMaxAttempts = signal<number | null>(null);
  private readonly attemptsUsed = signal<Record<string, number>>({});
  // Why a quiz could not be opened: shown on the load screen, or in the error card for the other modes.
  protected readonly problem = signal('');
  protected readonly errorLink = signal<PageLink | null>(null);
  // The check before a shared stage is in flight.
  protected readonly checking = signal(false);
  protected readonly joinError = signal('');
  protected readonly joining = signal(false);
  // What became of the last finished run of a shared quiz, for its result screen.
  protected readonly saveState = signal<SaveState | null>(null);
  // The leaderboard under the map and on the closed card: whose code it reads (a student's, or the previewed
  // assignment's), the count that tells it a result was saved and the board should be read again, and whether
  // the error card is the closed one of a student who joined, which shows the final board under its message.
  protected readonly boardCode = computed(() => this.mode() === 'preview' ? this.previewCode() : this.shareCode());
  protected readonly boardKey = signal(0);
  protected readonly closedBoard = signal(false);
  // The avatar dialog: whether it is open, the avatar picked in it so far and whether the change is being sent.
  protected readonly avatarOpen = signal(false);
  protected readonly avatarDraft = signal('');
  protected readonly avatarSaving = signal(false);

  protected readonly settings = this.settingsService.settings;
  protected readonly effectiveTimeMode = computed(() => this.assignmentTimeMode() ?? this.settings().timeMode);
  // Every stage with questions can be opened, passed or not: the teacher's preview, or an assignment whose
  // teacher chose the open lock.
  protected readonly allStagesOpen = computed(() =>
    this.mode() === 'preview' || this.assignmentStageLock() === 'open');

  // The stage being played, by its number (1-6): the identity of its game, as in the CSV and the progress.
  protected readonly stage = signal(1);
  protected readonly def = computed(() => stageDef(this.stage()));
  // What the player reads as the stage's number ("Màn 2"): its position among the stages the quiz has.
  protected readonly position = computed(() => {
    const quiz = this.quiz();
    return quiz ? stagePosition(quiz.stages.keys(), this.stage()) : this.stage();
  });
  protected readonly stageQuestionCount = computed(() => this.quiz()?.stages.get(this.stage())?.length ?? 0);
  protected readonly stageTimeLimit = computed(() =>
    timeLimitFor(this.def().seconds, this.effectiveTimeMode()));
  // The percentage of right answers that passes the stage being played, and the number of answers it makes.
  private readonly passPercent = computed(() => passPercentOf(this.assignmentPassPercents(), this.stage()));
  protected readonly stagePassMark = computed(() => passMark(this.stageQuestionCount(), this.passPercent()));
  protected readonly standTip = computed(() => STAND_TIP[this.def().vision]);

  // The runs each stage of the quiz has left, for the map; null when there is no limit to show.
  protected readonly attemptsLeftByStage = computed<Record<string, number> | null>(() => {
    const quiz = this.quiz();
    if (this.mode() !== 'shared' || this.assignmentMaxAttempts() === null || !quiz) {
      return null;
    }
    const left: Record<string, number> = {};
    for (const stage of quiz.stages.keys()) {
      left[String(stage)] = this.stageAttemptsLeft(stage) ?? 0;
    }
    return left;
  });
  // The same for the stage whose result is on screen.
  protected readonly resultAttemptsLeft = computed(() => {
    const run = this.result();
    return run ? this.stageAttemptsLeft(run.stage) : null;
  });

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
  // The request in flight for the page (the quiz, a join, the check before a stage): replaced when the route
  // changes under the page, so a late answer never lands on another quiz.
  private request: Subscription | null = null;
  // Counts finished shared runs, so a slow answer for an older run cannot overwrite a newer run's state.
  private submitSeq = 0;

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
      const code = params.get('code');
      const assignmentId = params.get('assignmentId');
      this.request?.unsubscribe();
      this.request = null;
      this.resetRun();
      this.jobId.set(id);
      this.assignmentId.set(assignmentId);
      this.shareCode.set(code?.trim().toUpperCase() ?? '');
      this.previewCode.set('');
      this.mode.set(code ? 'shared' : assignmentId ? 'preview' : id ? 'job' : 'local');
      this.baseQuiz.set(null);
      this.player.set(null);
      this.shared.set(null);
      this.assignmentTimeMode.set(null);
      this.assignmentStageLock.set(null);
      this.assignmentShowBoard.set(null);
      this.assignmentPassPercents.set(null);
      this.assignmentMaxAttempts.set(null);
      this.attemptsUsed.set({});
      this.errorLink.set(null);
      this.checking.set(false);
      this.joining.set(false);
      this.joinError.set('');
      this.saveState.set(null);
      this.closedBoard.set(false);
      this.avatarOpen.set(false);
      this.avatarSaving.set(false);
      if (code) {
        this.loadShared();
      } else if (assignmentId) {
        this.loadPreview(assignmentId);
      } else if (id) {
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
      this.fail('Đây không phải game. Hãy chọn nền tảng "Game" khi nhờ AI tạo.');
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
    const quiz = this.parseQuiz(text, title);
    if (!quiz) {
      return;
    }
    this.resetRun();
    this.problem.set('');
    this.baseQuiz.set(quiz);
    this.screen.set('map');
  }

  // The quiz in `text`, or null (after showing why) when it has nothing to play.
  private parseQuiz(text: string, title: string): GestureQuiz | null {
    const rows = this.csvImportService.parseCsvRows(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
    const quiz = parseGestureQuiz(rows, title);
    if (questionCount(quiz) === 0) {
      const none = {
        local: 'Không tìm thấy câu hỏi hợp lệ trong quiz này. Hãy dùng file Game do AI tạo (mục "AI › Tạo quiz").',
        shared: 'Bài này chưa có câu hỏi nào chơi được. Hãy báo thầy cô.',
        preview: 'Không tìm thấy câu hỏi hợp lệ trong bài này.',
      };
      const mode = this.mode();
      this.fail(none[mode === 'job' ? 'local' : mode]);
      return null;
    }
    // A student cannot do anything about rows the teacher's quiz lost, so only the others are told.
    if (quiz.skipped > 0 && this.mode() !== 'shared') {
      this.notificationService.warning(
        'Có dòng không dùng được',
        `Đã bỏ qua ${quiz.skipped} dòng không hợp lệ trong quiz.`,
        { nzPlacement: 'top' });
    }
    return quiz;
  }

  // The quiz a teacher gave out, as a student opens it. The CSV is the job's raw answer, so it is cleaned
  // like an AI job's. A device that has joined this quiz before goes straight to the map.
  private loadShared(): void {
    this.screen.set('loading');
    this.watch(this.sharedPlay.load(this.shareCode()), {
      next: shared => {
        const quiz = this.parseQuiz(this.aiCsvService.extractCsvContent(shared.csv), shared.title);
        if (!quiz) {
          return;
        }
        this.problem.set('');
        this.baseQuiz.set(quiz);
        this.shared.set({ label: shared.label, closesAt: shared.closesAt });
        this.assignmentTimeMode.set(shared.timeMode);
        this.assignmentStageLock.set(shared.stageLock);
        this.assignmentShowBoard.set(shared.showBoard);
        this.assignmentPassPercents.set(shared.passPercents);
        this.assignmentMaxAttempts.set(shared.maxAttempts ?? null);
        this.countAttempts(shared);
        const identity = this.sharedPlay.identity(this.shareCode());
        if (identity) {
          this.player.set(identity);
          this.screen.set('map');
          this.flushResults();
        } else {
          this.askToJoin();
        }
      },
      error: err => this.fail(this.sharedGone(err) ?? SHARED_FAILED),
    });
  }

  // The teacher's try-out of an assignment: its quiz and time mode, with nothing tied to a student.
  private loadPreview(id: string): void {
    this.screen.set('loading');
    this.watch(this.assignmentService.get(id), {
      next: detail => {
        this.assignmentTimeMode.set(detail.timeMode);
        this.assignmentStageLock.set(detail.stageLock);
        this.assignmentShowBoard.set(detail.showBoard);
        this.assignmentPassPercents.set(detail.passPercents);
        this.previewCode.set(detail.code.toUpperCase());
        this.shared.set({ label: detail.label, closesAt: detail.closesAt });
        this.openCsv(this.aiCsvService.extractCsvContent(detail.csv), detail.title);
      },
      error: err => this.fail('Không tải được bài này.', err instanceof HttpErrorResponse && err.status === 404),
    });
  }

  // Subscribes for the page, replacing the request that was in flight.
  private watch<T>(source: Observable<T>, observer: Partial<Observer<T>>): void {
    this.request?.unsubscribe();
    this.request = source.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(observer);
  }

  // What a final answer from the server means to a student: the link points at nothing (404) or the
  // assignment is over (410). Anything else (offline, a server error) may pass, so it gives null.
  private sharedGone(err: unknown): string | null {
    const status = err instanceof HttpErrorResponse ? err.status : 0;
    return status === 404 ? SHARED_MISSING : status === 410 ? SHARED_CLOSED : null;
  }

  // A quiz opened from a job, a shared quiz or a preview has no load screen to go back to, so its problems
  // get their own card, with a way back for the two signed-in modes (a student has none).
  private fail(message: string, missing = false): void {
    this.problem.set(message);
    // A student who joined sees the final board under "closed": the leaderboard route answers after the close.
    this.closedBoard.set(
      message === SHARED_CLOSED && this.mode() === 'shared' && this.sharedPlay.identity(this.shareCode()) !== null);
    this.screen.set(this.mode() === 'local' ? 'load' : 'error');
    // An assignment that is gone has no leaderboard page to return to, only the list.
    this.errorLink.set(missing ? { url: '/assignments', text: 'Về danh sách bài đã giao' } : this.backLink());
  }

  // ---- A student joining ----

  // The join screen: this device is not a known student of the quiz (yet, or any more).
  private askToJoin(): void {
    this.player.set(null);
    this.joining.set(false);
    this.joinError.set('');
    this.screen.set('join');
  }

  protected joinQuiz(request: JoinRequest): void {
    if (this.joining()) {
      return;
    }
    this.joining.set(true);
    this.joinError.set('');
    this.watch(this.sharedPlay.join(this.shareCode(), request.name, request.avatar), {
      next: identity => {
        this.joining.set(false);
        this.player.set(identity);
        // A new student has played nothing, whatever the student before them on this device had.
        this.attemptsUsed.set({});
        this.resetRun();
        this.screen.set('map');
        this.flushResults();
      },
      error: err => {
        this.joining.set(false);
        const gone = this.sharedGone(err);
        if (gone) {
          this.fail(gone);
        } else {
          this.joinError.set(this.joinProblem(err));
        }
      },
    });
  }

  // The server's plain-text answer to a join, in words a student can act on.
  private joinProblem(err: unknown): string {
    const status = err instanceof HttpErrorResponse ? err.status : 0;
    const body = err instanceof HttpErrorResponse && typeof err.error === 'string' ? err.error.trim() : '';
    if (status === 409 && body === 'Name taken') {
      return 'Tên này đã có bạn dùng, hãy thêm họ hoặc số.';
    }
    if (status === 409 && body === 'Assignment is full') {
      return 'Bài đã đủ số học sinh, hãy báo thầy cô.';
    }
    if (status === 400) {
      return 'Tên cần từ 1 đến 40 ký tự.';
    }
    if (status === 0) {
      return 'Mất kết nối, hãy thử lại.';
    }
    return 'Chưa vào được bài, hãy thử lại.';
  }

  // "Không phải bạn?": this device joins again as someone else. The old student stays in the teacher's list.
  protected switchPlayer(event: Event): void {
    event.preventDefault();
    this.sharedPlay.forget(this.shareCode());
    this.askToJoin();
  }

  // The avatar button on the map's line opens the picker with the student's own avatar chosen (or a random one,
  // for a student who has none yet).
  protected openAvatarPicker(): void {
    const own = this.playerAvatar();
    this.avatarDraft.set(avatarDef(own) ? own : randomAvatar());
    this.avatarOpen.set(true);
  }

  protected closeAvatarPicker(): void {
    this.avatarOpen.set(false);
  }

  // "Lưu" in the avatar dialog. The device's identity is the truth, kept by the service: a 403 means the teacher
  // removed this student (the service has forgotten them already), so the join screen comes back, and a 410
  // means the assignment closed, so the closed card does. Any other failure keeps the dialog for another try.
  protected saveAvatar(): void {
    const draft = this.avatarDraft();
    if (this.avatarSaving()) {
      return;
    }
    if (draft === this.playerAvatar()) {
      this.avatarOpen.set(false);
      return;
    }
    const code = this.shareCode();
    this.avatarSaving.set(true);
    this.sharedPlay.setAvatar(code, draft).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: identity => {
        if (code !== this.shareCode()) {
          return;
        }
        this.avatarSaving.set(false);
        this.avatarOpen.set(false);
        if (identity.playerId === this.player()?.playerId) {
          this.player.set(identity);
        }
        // The board shows the new picture.
        this.boardKey.update(key => key + 1);
      },
      error: err => {
        if (code !== this.shareCode()) {
          return;
        }
        this.avatarSaving.set(false);
        const status = err instanceof HttpErrorResponse ? err.status : 0;
        if (status === 403) {
          this.avatarOpen.set(false);
          this.askToJoin();
        } else if (status === 410) {
          this.avatarOpen.set(false);
          this.fail(SHARED_CLOSED);
        } else {
          this.notificationService.error('Chưa đổi được hình', 'Thử lại nhé.', { nzPlacement: 'top' });
        }
      },
    });
  }

  // Sends the results that could not be delivered earlier. Not tied to a student: each queued result
  // carries the token it was made with.
  private flushResults(): void {
    this.sharedPlay.flush(this.shareCode()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }

  @HostListener('window:online')
  protected onOnline(): void {
    if (this.mode() === 'shared') {
      this.flushResults();
    }
  }

  // ---- Moving between the screens ----

  protected openIntro(stage: number): void {
    if (this.mode() === 'shared') {
      this.guardSharedStage(stage, () => this.showIntro(stage));
      return;
    }
    const quiz = this.quiz();
    // A preview opens every stage, whatever was passed.
    const open = this.allStagesOpen() || (quiz !== null && this.progress.isUnlocked(quiz, stage));
    if (!quiz || !quiz.stages.has(stage) || !open) {
      return;
    }
    this.showIntro(stage);
  }

  private showIntro(stage: number): void {
    this.stage.set(stage);
    this.screen.set('intro');
    this.prepareVision();
  }

  // What a shared quiz needs before one of its stages starts (or is replayed): the device must still be a
  // known student (the stored identity is the truth: another tab may have changed it, or a rejected result
  // removed it), the stage must be open for that student, and the assignment must not have closed in the
  // meantime. When the teacher limited the runs of a stage, one with none left cannot start, by what this
  // page counts and again by what the server answers. A server that cannot be reached does not stop the
  // student: the run is played and its result queued. The wait is a quick spinner, with no delay added when
  // the answer is fast.
  private guardSharedStage(stage: number, proceed: () => void): void {
    const identity = this.sharedPlay.identity(this.shareCode());
    if (!identity) {
      this.askToJoin();
      return;
    }
    if (identity.playerId !== this.player()?.playerId) {
      this.player.set(identity);
    }
    const quiz = this.quiz();
    if (!quiz?.stages.has(stage) || !(this.allStagesOpen() || this.progress.isUnlocked(quiz, stage))) {
      return;
    }
    if (this.stageAttemptsLeft(stage) === 0) {
      this.backToMap();
      return;
    }
    this.checking.set(true);
    this.screen.set('loading');
    this.watch(this.sharedPlay.load(this.shareCode()).pipe(timeout(STAGE_CHECK_TIMEOUT_MS)), {
      next: shared => {
        this.checking.set(false);
        this.shared.set({ label: shared.label, closesAt: shared.closesAt });
        this.countAttempts(shared);
        if (this.stageAttemptsLeft(stage) === 0) {
          // The server counts more runs than this page knew of (another tab): the map shows the stage used up.
          this.backToMap();
          return;
        }
        proceed();
      },
      error: err => {
        this.checking.set(false);
        const gone = this.sharedGone(err);
        if (gone) {
          this.fail(gone);
        } else {
          proceed();
        }
      },
    });
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
    // A student whose name was removed by the teacher is not a known student any more: the map is theirs.
    if (this.mode() === 'shared' && !this.sharedPlay.identity(this.shareCode())) {
      this.askToJoin();
      return;
    }
    this.screen.set('map');
  }

  // Another quiz from a file: only for a quiz that was opened on this page, not for a job's.
  protected openAnother(): void {
    this.resetRun();
    this.vision.stopCamera();
    this.baseQuiz.set(null);
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
    if (this.mode() === 'shared') {
      this.guardSharedStage(this.stage(), () => this.startRun());
      return;
    }
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
    // A preview keeps nothing, not even on this device: the verdict is worked out without writing progress,
    // and since every stage is open the next one is offered whether or not this run passed.
    const preview = this.mode() === 'preview';
    const percent = passPercentOf(this.assignmentPassPercents(), stage);
    const passed = preview
      ? this.correctCount >= passMark(total, percent)
      : this.progress.record(quiz.key, stage, this.correctCount, total, percent);
    this.result.set({
      stage,
      position: stagePosition(quiz.stages.keys(), stage),
      correct: this.correctCount,
      total,
      points: this.score(),
      passMark: passMark(total, percent),
      passed,
      bestStreak: this.bestStreak,
      missed: this.missed,
      hasNext: (this.allStagesOpen() || passed) && this.nextStageWithQuestions(stage) !== null,
    });
    this.reveal.set(null);
    this.audio.play(passed ? 'finish' : 'wrong');
    if (this.mode() === 'shared') {
      // Counted at once, before the server answers, so a replay cannot slip in while the result is on its way.
      this.attemptsUsed.update(used => ({ ...used, [String(stage)]: (used[String(stage)] ?? 0) + 1 }));
      this.saveResult(stage, this.correctCount, total);
    }
    this.screen.set('result');
  }

  // Reports a finished run to the teacher. The page is not tied to the request: a student who leaves right
  // after finishing must not cancel it, and the service queues what it cannot deliver. The result screen
  // shows how it went, unless a newer run has finished since.
  private saveResult(stage: number, correct: number, total: number): void {
    const seq = ++this.submitSeq;
    this.saveState.set('saving');
    this.sharedPlay.submit(this.shareCode(), { stage, correct, total }).subscribe(outcome => {
      if (outcome === 'limit') {
        // The server had all the runs of this stage already (another tab or device played them): the run is
        // not kept, nor queued, and the stage is used up.
        this.useUpAttempts(stage);
      }
      if (seq === this.submitSeq) {
        this.saveState.set(outcome);
      }
      if (outcome === 'saved') {
        // The leaderboard on the map may be on screen by now (the student left the result before the answer).
        this.boardKey.update(key => key + 1);
      }
    });
  }

  // The runs `stage` has left for this student: null outside a shared quiz (a teacher's preview and a file are
  // never limited) or when the teacher set no limit.
  private stageAttemptsLeft(stage: number): number | null {
    return this.mode() === 'shared'
      ? attemptsLeft(this.assignmentMaxAttempts(), this.attemptsUsed()[String(stage)])
      : null;
  }

  // Takes what the server says this student has used, and what this device has waiting to be sent, as the
  // runs used. Never less than this page already counted: a run in flight may not be in the server's number
  // yet, and a stage must not open up again because of that.
  private countAttempts(shared: SharedQuiz): void {
    const queued = this.sharedPlay.pendingByStage(this.shareCode());
    const merged: Record<string, number> = {};
    for (const key of Object.keys({ ...shared.attempts, ...queued })) {
      merged[key] = (shared.attempts?.[key] ?? 0) + (queued[key] ?? 0);
    }
    this.attemptsUsed.update(used => {
      const next = { ...merged };
      for (const [key, count] of Object.entries(used)) {
        next[key] = Math.max(next[key] ?? 0, count);
      }
      return next;
    });
  }

  private useUpAttempts(stage: number): void {
    const max = this.assignmentMaxAttempts();
    if (max !== null) {
      this.attemptsUsed.update(used => ({ ...used, [String(stage)]: Math.max(max, used[String(stage)] ?? 0) }));
    }
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
