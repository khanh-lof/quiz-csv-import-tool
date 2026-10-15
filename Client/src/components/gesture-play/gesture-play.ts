import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  NgZone,
  OnDestroy,
  OnInit,
  signal,
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
import { Choice, QuestionView, Reveal, StageGameBase, VisionFrame, VisionKind } from '../../game/stage-game';
import { passMark, stageDef, stagePosition, STAGES } from '../../game/stages';
import { VisionService } from '../../game/vision.service';
import { AiJob } from '../../models/ai-job';
import {
  attemptsLeft,
  formatClose,
  passPercentOf,
  placeholderQuiz,
  PlayerIdentity,
  SharedQuestion,
  SharedQuiz,
  SharedRunStart,
  SharedStageResult,
  SharedVerdict,
  StageLock,
} from '../../models/assignment';
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

// What the page says when a quiz has nothing to play, by how it was opened (a job reads like a file).
const NO_QUESTIONS = {
  local: 'Không tìm thấy câu hỏi hợp lệ trong quiz này. Hãy dùng file Game do AI tạo (mục "AI › Tạo quiz").',
  shared: 'Bài này chưa có câu hỏi nào chơi được. Hãy báo thầy cô.',
  preview: 'Không tìm thấy câu hỏi hợp lệ trong bài này.',
};

// The server's answer when it has no such run any more: the student started the stage again elsewhere.
const RUN_NOT_FOUND = 'Run not found';

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
// in this time must not keep the student from reaching the stage's intro (starting the run reports its own failure).
const STAGE_CHECK_TIMEOUT_MS = 4000;

// A shared question's time is up this long before the server's cutoff (its time limit plus its grace), whatever
// the page's own clock says, so the answer that says so is on its way while it still counts.
const DEADLINE_MARGIN_MS = 1000;

// A file saved by Excel starts with this mark; it would stick to the first cell and hide the header row.
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

const STAND_TIP: Record<VisionKind, string> = {
  hand: 'Đứng cách webcam 0,6–1,2 m, tay trong khung hình, đủ sáng (đừng ngược sáng).',
  face: 'Cách webcam 0,6–1,2 m, nhìn thẳng, mặt đủ sáng, chỉ một người trong khung hình.',
};

// The question a student plays when the server deals it: what the games show and nothing else. The answer, which
// the server keeps until the question is answered, is filled in from its verdict (`withVerdict`).
function sharedPlayQuestion(stage: number, served: SharedQuestion): PlayQuestion {
  const view: QuestionView = {
    stage,
    question: served.question,
    options: served.options ?? []
  };
  if (served.chunks) {
    view.chunks = served.chunks;
  }
  return {
    source: {
      stage,
      question: served.question,
      correct: '',
      wrong: [],
      explanation: ''
    },
    view,
    correctIndex: null,
    correctOrder: null,
  };
}

// The same question once the server has judged it: the right answer and the explanation are known now. The
// `view` is kept as it is, so the game on screen is not given another question to redraw.
function withVerdict(play: PlayQuestion, verdict: SharedVerdict): PlayQuestion {
  return {
    ...play,
    source: {
      ...play.source,
      correct: verdict.answer,
      explanation: verdict.explanation
    },
    correctIndex: verdict.correctIndex ?? null,
    correctOrder: verdict.correctOrder ?? null,
  };
}

// The status and the plain-text body of a failed request, as the page reads them (0 and '' when the server
// could not be reached).
function failureOf(err: unknown): { status: number; body: string } {
  return err instanceof HttpErrorResponse
    ? {
      status: err.status,
      body: typeof err.error === 'string' ? err.error.trim() : ''
    }
    : {
      status: 0,
      body: ''
    };
}

// The gesture quiz page, played full screen outside the workspace frame. It loads a quiz (from an AI job
// or a CSV file, or the built-in sample; or a teacher's assignment, for a student and as the teacher's
// preview), shows the stages it has (1 to 6 of the six) as a map, and runs one stage at a time:
// the page owns the timer, the camera and the scoring, and the stage's game component only turns the
// player's gestures (or mouse and keyboard) into a choice. It also owns the questions and judges the
// answers, except for a student's assignment, where the server does both and the page only shows what
// it is dealt (see `startSharedRun`). MediaPipe is loaded through VisionService only when the camera is
// turned on, so this whole page is a lazy chunk.
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
  protected readonly screen = signal<Screen>('loading');
  protected readonly mode = signal<Mode>('local');
  // The AI job being played, when the page was opened from the jobs table ("Chơi ngay").
  protected readonly jobId = signal<string | null>(null);
  // The assignment being previewed (the teacher), and the code of the shared quiz, upper-cased (a student).
  protected readonly assignmentId = signal<string | null>(null);
  protected readonly shareCode = signal('');
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
        return {
          url: '/ai-history',
          text: 'Về lịch sử AI'
        };
      case 'preview':
        return {
          url: `/assignments/${encodeURIComponent(this.assignmentId() ?? '')}`,
          text: 'Về bảng xếp hạng'
        };
      case 'local':
        return {
          url: '/quiz',
          text: 'Về bảng quiz'
        };
      default:
        return null;
    }
  });
  // The teacher's time mode, which replaces the player's own setting for an assignment.
  protected readonly assignmentTimeMode = signal<TimeMode | null>(null);
  // The teacher's stage lock: `open` lets the student play any stage from the start.
  protected readonly assignmentStageLock = signal<StageLock | null>(null);
  // board component then copes with the server's 404 `Board hidden` itself.
  protected readonly assignmentShowBoard = signal<boolean | null>(null);
  // as the server sent them; null outside an assignment, where the stage's own seconds are the default for practice.
  protected readonly assignmentTimeLimits = signal<Record<string, number | null> | null>(null);
  // The teacher's pass percentage of each stage ("1" to "6"); null outside an assignment, where it is the default.
  protected readonly assignmentPassPercents = signal<Record<string, number> | null>(null);
  // moment it starts. Only a shared quiz is ever limited.
  protected readonly assignmentMaxAttempts = signal<number | null>(null);
  // Why a quiz could not be opened: shown on the load screen, or in the error card for the other modes.
  protected readonly problem = signal('');
  protected readonly errorLink = signal<PageLink | null>(null);
  // The check before a shared stage is in flight.
  protected readonly checking = signal(false);
  protected readonly joinError = signal('');
  protected readonly joining = signal(false);
  // The quiz as it was loaded, and the student playing it. What is played (`quiz`) is the same quiz under
  // a key of its own for that student, so GestureProgressService keeps each student's locks and bests
  // Whether the last finished run of a shared quiz is on the server, for its result screen.
  protected readonly saveState = signal<SaveState | null>(null);
  protected readonly boardKey = signal(0);
  protected readonly closedBoard = signal(false);
  // The avatar dialog: whether it is open, the avatar picked in it so far and whether the change is being sent.
  protected readonly avatarOpen = signal(false);
  protected readonly avatarDraft = signal('');
  protected readonly avatarSaving = signal(false);
  protected readonly effectiveTimeMode = computed(() => this.assignmentTimeMode() ?? this.settings().timeMode);
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
  // The teacher's choice to show the board to students. Null while unknown, which is the closed card of a link
  // that was already closed when opened (GET share/{code} answered 410, so the page never learnt it): the
  protected readonly stageQuestionCount = computed(() => this.quiz()?.stages.get(this.stage())?.length ?? 0);
  // The seconds a question of each stage ("1" to "6") lasts in the assignment (time mode applied, null: no limit),
  // practice from a file or a job uses the stage's own seconds in the player's time mode.
  protected readonly stageTimeLimit = computed(() => {
    const limits = this.assignmentTimeLimits();
    const own = limits?.[String(this.stage())];
    return limits && own !== undefined ? own : timeLimitFor(this.def().seconds, this.effectiveTimeMode());
  });
  protected readonly standTip = computed(() => STAND_TIP[this.def().vision]);
  // The teacher's limit on the runs of each stage (an assignment with the open lock), null for none, and the
  // runs this student has used of each stage ("1" to "6"), as the server counts them: a run counts from the
  // the last request failed even after the service's retries and waits for "Thử lại".
  protected readonly starting = signal(false);
  protected readonly answering = signal(false);
  protected readonly advancing = signal(false);
  protected readonly connectionLost = signal(false);
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
  // One run of a stage.
  protected readonly questions = signal<PlayQuestion[]>([]);
  protected readonly index = signal(0);
  protected readonly score = signal(0);
  // The leaderboard under the map and on the closed card: whose code it reads (a student's, or the previewed
  // assignment's), the count that tells it a result was saved and the board should be read again, and whether
  protected readonly streak = signal(0);
  protected readonly reveal = signal<Reveal | null>(null);
  protected readonly paused = signal(false);
  // changes, so the page is not redrawn on every frame.
  protected readonly secondsLeft = signal<number | null>(null);
  protected readonly result = signal<StageRunResult | null>(null);
  // The same for the stage whose result is on screen.
  protected readonly resultAttemptsLeft = computed(() => {
    const run = this.result();
    return run ? this.stageAttemptsLeft(run.stage) : null;
  });
  protected readonly current = computed(() => this.questions()[this.index()] ?? null);
  protected readonly view = computed(() => this.current()?.view ?? null);
  // Every stage with questions can be opened, passed or not: the teacher's preview, or an assignment whose
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
      return {
        kind: 'wrong',
        text: '⏱ Hết giờ'
      };
    }
    return reveal.correct
      ? {
        kind: 'correct',
        text: `✓ Chính xác! +${POINTS_PER_CORRECT}`
      }
      : {
        kind: 'wrong',
        text: '✗ Chưa đúng'
      };
  });
  protected readonly cameraOn = computed(() => this.cameraState() === 'on');
  protected readonly cameraActive = computed(() => this.cameraOn() && this.modelState() === 'ready');
  protected readonly tracking = signal<Tracking>('lost');
  // The seconds a question of the stage being played lasts, or null for no limit. An assignment's come from the
  // server, which may configure them differently from `STAGES`, and a page cannot be trusted with the table;
  protected readonly fullscreen = signal(false);
  protected readonly cameraChip = computed<Chip>(() => {
    switch (this.cameraState()) {
      case 'on':
        return {
          text: 'Camera bật',
          tone: 'ok'
        };
      case 'starting':
        return {
          text: 'Đang bật camera…',
          tone: 'wait'
        };
      case 'off':
        return {
          text: 'Camera tắt',
          tone: 'off'
        };
      default:
        return {
          text: 'Không dùng được camera',
          tone: 'bad'
        };
    }
  });
  // The recognition model's state, only while there is a camera for it to read.
  protected readonly modelChip = computed<Chip | null>(() => {
    if (this.cameraState() !== 'on' && this.cameraState() !== 'starting') {
      return null;
    }
    switch (this.modelState()) {
      case 'loading':
        return {
          text: 'Đang tải nhận diện…',
          tone: 'wait'
        };
      case 'ready':
        return {
          text: 'Nhận diện sẵn sàng',
          tone: 'ok'
        };
      case 'error':
        return {
          text: 'Chưa tải được nhận diện',
          tone: 'bad'
        };
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
        return {
          text: hand ? 'Đã thấy tay ✓' : 'Đã thấy mặt ✓',
          tone: 'ok'
        };
      case 'multi':
        return {
          text: 'Chỉ một người trước camera',
          tone: 'bad'
        };
      default:
        return {
          text: hand ? 'Đưa tay vào khung hình' : 'Chưa thấy mặt',
          tone: 'wait'
        };
    }
  });

  // A shared run is played against the server: the run is being started, an answer is out (the page ignores
  // further input and its clock stands still until the verdict comes), the next question is being fetched, or
  private readonly route = inject(ActivatedRoute);
  private readonly zone = inject(NgZone);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  // How many questions the run being played has, as the server dealt it. Only questions already dealt are in
  private readonly notificationService = inject(NzNotificationService);
  private readonly jobService = inject(AiJobService);
  // Pausing would not stop that clock, so it is not offered while a timed question of a shared run is open
  private readonly assignmentService = inject(AssignmentService);
  private readonly sharedPlay = inject(SharedPlayService);
  private readonly aiCsvService = inject(AiCsvService);
  private readonly csvImportService = inject(CsvImportService);
  private readonly progress = inject(GestureProgressService);
  private readonly settingsService = inject(GestureSettingsService);
  protected readonly settings = this.settingsService.settings;
  private readonly vision = inject(VisionService);
  // The camera, and whether this stage's model is ready: only then do gestures reach the game.
  protected readonly cameraState = this.vision.cameraState;
  // The whole seconds left on this question (null without a time limit): written only when the second
  protected readonly modelState = computed(() => this.vision.modelState(this.def().vision)());
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
  private readonly audio = inject(GameAudio);
  // The code of the assignment being previewed: the board under its map is read by it, as a student's is.
  private readonly previewCode = signal('');
  // the error card is the closed one of a student who joined, which shows the final board under its message.
  protected readonly boardCode = computed(() => this.mode() === 'preview' ? this.previewCode() : this.shareCode());
  // apart from other students' and from the same quiz played as a file or a job.
  private readonly baseQuiz = signal<GestureQuiz | null>(null);
  private readonly player = signal<PlayerIdentity | null>(null);
  protected readonly quiz = computed<GestureQuiz | null>(() => {
    const base = this.baseQuiz();
    const player = this.player();
    return base && player && this.mode() === 'shared'
      ? {
        ...base,
        key: `asg:${this.shareCode()}:${player.playerId}`
      }
      : base;
  });
  protected readonly playerName = computed(() => this.player()?.name ?? '');
  protected readonly playerAvatar = computed(() => this.player()?.avatar ?? '');
  private readonly attemptsUsed = signal<Record<string, number>>({});
  // The percentage of right answers that passes the stage being played, and the number of answers it makes.
  private readonly passPercent = computed(() => passPercentOf(this.assignmentPassPercents(), this.stage()));
  protected readonly stagePassMark = computed(() => passMark(this.stageQuestionCount(), this.passPercent()));
  // `questions`, one more with each "Tiếp".
  private readonly runTotal = signal(0);
  protected readonly totalQuestions = computed(() =>
    this.mode() === 'shared' ? this.runTotal() : this.questions().length);
  // The open question is timed by the server's clock, which cannot be stopped.
  private readonly serverClock = signal(false);
  // (after the verdict it is: nothing is running then).
  protected readonly pauseLocked = computed(() =>
    this.mode() === 'shared' && this.serverClock() && this.reveal() === null);
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
  // The shared run being played. `runSeq` counts the runs the page has started or left, so an answer that comes
  // back for an older run, or for another quiz, is dropped; `runRequest` is that run's request in flight and goes
  // with it. `deadline` is the time (performance.now) at which the open question is up whatever the page's clock
  // says, `finalResult` the server's numbers once its last question has been judged, and `retryAction` what
  // "Thử lại" sends again.
  private runId: string | null = null;
  private runSeq = 0;
  private runRequest: Subscription | null = null;
  private deadline: number | null = null;
  private finalResult: SharedStageResult | null = null;
  private retryAction: (() => void) | null = null;

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
      this.assignmentTimeLimits.set(null);
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

  // "Không phải bạn?": this device joins again as someone else. The old student stays in the teacher's list.
  protected switchPlayer(event: Event): void {
    event.preventDefault();
    this.sharedPlay.forget(this.shareCode());
    this.askToJoin();
  }

  // for a student who has none yet).
  protected openAvatarPicker(): void {
    const own = this.playerAvatar();
    this.avatarDraft.set(avatarDef(own) ? own : randomAvatar());
    this.avatarOpen.set(true);
  }

  protected closeAvatarPicker(): void {
    this.avatarOpen.set(false);
  }

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

  // The quiz a teacher gave out, as a student opens it. The server does not send its questions (it deals them
  // one at a time as they are played), only how many each stage has, which is all the map and the intro need. A

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

  // What a final answer from the server means to a student: the link points at nothing (404) or the

  // Another quiz from a file: only for a quiz that was opened on this page, not for a job's.
  protected openAnother(): void {
    this.resetRun();
    this.vision.stopCamera();
    this.baseQuiz.set(null);
    this.problem.set('');
    this.screen.set('load');
  }

  // A quiz opened from a job, a shared quiz or a preview has no load screen to go back to, so its problems

  protected openNextStage(): void {
    const next = this.nextStageWithQuestions(this.stage());
    if (next === null) {
      this.backToMap();
    } else {
      this.openIntro(next);
    }
  }

  // ---- A student joining ----

  protected retryStage(): void {
    this.audio.resume();
    if (this.mode() === 'shared') {
      this.guardSharedStage(this.stage(), () => this.startRun());
      return;
    }
    this.startRun();
  }

  // Called by the game with the player's choice, possibly from the animation loop outside Angular.
  protected onChoose(choice: Choice): void {
    this.inZone(() => {
      const play = this.current();
      if (!play || this.screen() !== 'playing' || this.paused() || this.reveal() !== null || this.answering()) {
        return;
      }
      if (this.mode() === 'shared') {
        this.sendAnswer(choice);
      } else {
        this.showReveal(play, judge(play, choice));
      }
    });
  }

  // "Tiếp": on to the next question, or the result after the last one.
  protected next(): void {
    this.inZone(() => {
      if (this.reveal() === null || this.screen() !== 'playing') {
        return;
      }
      if (this.mode() === 'shared') {
        this.nextShared();
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

  // "Thử lại" in the feedback bar: sends the request that failed again.
  protected retryConnection(): void {
    const retry = this.retryAction;
    this.retryAction = null;
    this.connectionLost.set(false);
    retry?.();
  }

  // The avatar button on the map's line opens the picker with the student's own avatar chosen (or a random one,

  protected togglePause(): void {
    if (this.screen() === 'playing' && !this.pauseLocked()) {
      this.paused.update(paused => !paused);
    }
  }

  protected toggleSound(): void {
    this.settingsService.update({ sound: !this.settings().sound });
  }

  // "Lưu" in the avatar dialog. The device's identity is the truth, kept by the service: a 403 means the teacher
  // removed this student (the service has forgotten them already), so the join screen comes back, and a 410

  protected toggleCamera(): void {
    const state = this.vision.cameraState();
    if (state === 'on' || state === 'starting') {
      this.vision.stopCamera();
      this.settingsService.update({ useCamera: false });
      return;
    }
    void this.enableCamera();
  }

  // ---- Moving between the screens ----

  protected retryModel(): void {
    void this.loadModel(this.def().vision);
  }

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

  // What a shared quiz needs before one of its stages starts (or is replayed): the device must still be a
  // known student (the stored identity is the truth: another tab may have changed it, or a refused request
  // removed it), the stage must be open for that student, and the assignment must not have closed in the
  // meantime. The server's answer also brings the student's runs and results up to date, which is where the
  // stage lock and the replay limit really live: the map and the stage are checked again against them. A
  // server that cannot be reached does not stop the student from reaching the intro, where starting the run

  // question instead of a timed-out one. Not for a shared question the server is timing: it keeps running.
  @HostListener('document:visibilitychange')
  protected onVisibilityChange(): void {
    if (document.hidden && this.screen() === 'playing' && !this.pauseLocked()) {
      this.paused.set(true);
    }
  }

  // Whether `stage` can be opened by this student: it is in the quiz, and either every stage is open or the

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
      this.failNoQuestions();
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

  private failNoQuestions(): void {
    const mode = this.mode();
    this.fail(NO_QUESTIONS[mode === 'job' ? 'local' : mode]);
  }

  // ---- Playing a stage ----

  // device that has joined this quiz before goes straight to the map.
  private loadShared(): void {
    this.screen.set('loading');
    this.watch(this.sharedPlay.load(this.shareCode()), {
      next: shared => {
        const quiz = placeholderQuiz(shared.title, `asg:${this.shareCode()}`, shared.stageCounts ?? {});
        if (questionCount(quiz) === 0) {
          this.failNoQuestions();
          return;
        }
        this.problem.set('');
        this.baseQuiz.set(quiz);
        this.shared.set({
          label: shared.label,
          closesAt: shared.closesAt
        });
        this.assignmentTimeMode.set(shared.timeMode);
        this.assignmentTimeLimits.set(shared.timeLimits ?? null);
        this.assignmentStageLock.set(shared.stageLock);
        this.assignmentShowBoard.set(shared.showBoard);
        this.assignmentPassPercents.set(shared.passPercents);
        this.assignmentMaxAttempts.set(shared.maxAttempts ?? null);
        this.countAttempts(shared);
        const identity = this.sharedPlay.identity(this.shareCode());
        if (identity) {
          this.player.set(identity);
          this.syncProgress(shared);
          this.screen.set('map');
        } else {
          this.askToJoin();
        }
      },
      error: err => this.fail(this.sharedGone(err) ?? SHARED_FAILED),
    });
  }

  // The state every run starts from, whoever judges it: the questions it has (all of them for a local run, only

  // The teacher's try-out of an assignment: its quiz and time mode, with nothing tied to a student.
  private loadPreview(id: string): void {
    this.screen.set('loading');
    this.watch(this.assignmentService.get(id), {
      next: detail => {
        this.assignmentTimeMode.set(detail.timeMode);
        this.assignmentTimeLimits.set(detail.timeLimits ?? null);
        this.assignmentStageLock.set(detail.stageLock);
        this.assignmentShowBoard.set(detail.showBoard);
        this.assignmentPassPercents.set(detail.passPercents);
        this.previewCode.set(detail.code.toUpperCase());
        this.shared.set({
          label: detail.label,
          closesAt: detail.closesAt
        });
        this.openCsv(this.aiCsvService.extractCsvContent(detail.csv), detail.title);
      },
      error: err => this.fail('Không tải được bài này.', err instanceof HttpErrorResponse && err.status === 404),
    });
  }

  // Back to a state where nothing is being played, so a stale run can never be seen or judged. A shared run's

  // Subscribes for the page, replacing the request that was in flight.
  private watch<T>(source: Observable<T>, observer: Partial<Observer<T>>): void {
    this.request?.unsubscribe();
    this.request = source.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(observer);
  }

  // assignment is over (410). Anything else (offline, a server error) may pass, so it gives null.
  private sharedGone(err: unknown): string | null {
    const status = err instanceof HttpErrorResponse ? err.status : 0;
    return status === 404 ? SHARED_MISSING : status === 410 ? SHARED_CLOSED : null;
  }

  // get their own card, with a way back for the two signed-in modes (a student has none).
  private fail(message: string, missing = false): void {
    this.problem.set(message);
    // A student who joined sees the final board under "closed": the leaderboard route answers after the close.
    this.closedBoard.set(
      message === SHARED_CLOSED && this.mode() === 'shared' && this.sharedPlay.identity(this.shareCode()) !== null);
    this.screen.set(this.mode() === 'local' ? 'load' : 'error');
    // An assignment that is gone has no leaderboard page to return to, only the list.
    this.errorLink.set(missing ? {
      url: '/assignments',
      text: 'Về danh sách bài đã giao'
    } : this.backLink());
  }

  // The join screen: this device is not a known student of the quiz (yet, or any more).
  private askToJoin(): void {
    this.player.set(null);
    this.joining.set(false);
    this.joinError.set('');
    this.screen.set('join');
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

  private showIntro(stage: number): void {
    this.stage.set(stage);
    this.screen.set('intro');
    this.prepareVision();
  }

  // reports its own failure. The wait is a quick spinner, with no delay added when the answer is fast.
  private guardSharedStage(stage: number, proceed: () => void): void {
    const identity = this.sharedPlay.identity(this.shareCode());
    if (!identity) {
      this.askToJoin();
      return;
    }
    if (identity.playerId !== this.player()?.playerId) {
      this.player.set(identity);
    }
    if (!this.stageOpen(stage)) {
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
        this.shared.set({
          label: shared.label,
          closesAt: shared.closesAt
        });
        this.assignmentTimeLimits.set(shared.timeLimits ?? null);
        this.countAttempts(shared);
        this.syncProgress(shared);
        if (!this.stageOpen(stage) || this.stageAttemptsLeft(stage) === 0) {
          // The server knows less passed, or more runs used (another tab or device), than this page did: the
          // map now shows the stage locked or used up.
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

  // ---- A student's run, judged by the server ----

  // A shared quiz is not played against questions the page holds: it asks the server to start the stage, is dealt
  // one question at a time without its answer, sends each choice and shows the verdict that comes back, so there
  // is nothing in the page to read the answers from, no clock to change and no score to make up. Every request
  // belongs to the run it was made for (`watchRun`).

  // ones before it are passed.
  private stageOpen(stage: number): boolean {
    const quiz = this.quiz();
    return !!quiz?.stages.has(stage) && (this.allStagesOpen() || this.progress.isUnlocked(quiz, stage));
  }

  private nextStageWithQuestions(stage: number): number | null {
    const quiz = this.quiz();
    return STAGES.find(def => def.stage > stage && quiz?.stages.has(def.stage))?.stage ?? null;
  }

  // Subscribes for the run being played, replacing the request that was in flight. What comes back after the run

  private startRun(): void {
    if (this.mode() === 'shared') {
      this.startSharedRun();
      return;
    }
    const quiz = this.quiz();
    if (!quiz) {
      return;
    }
    const def = this.def();
    // Every run asks the stage's questions in a new order.
    this.beginRun(shuffled(quiz.stages.get(def.stage) ?? []).map(prepareQuestion));
    this.limit = this.stageTimeLimit();
    this.startQuestionTimer();
    this.screen.set('playing');
    this.prepareVision();
  }

  // The clock of a question the server dealt. It started when the server dealt the question, so the time left is
  // the server's figure (null: no limit), which only differs from the stage's own for a question fetched again.
  // The page's own clock waits for a face game's calibration, but the server's does not: once the question's time
  // and the grace the server adds for the network are over, an answer would come too late, so time is up whatever

  // the first for a shared one) and nothing scored yet.
  private beginRun(questions: PlayQuestion[]): void {
    this.questions.set(questions);
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
  }

  // Sends the choice for the question on screen (null: the time ran out). While it is out the page ignores

  // request in flight goes with it.
  private resetRun(): void {
    this.runSeq += 1;
    this.runRequest?.unsubscribe();
    this.runRequest = null;
    this.runId = null;
    this.runTotal.set(0);
    this.starting.set(false);
    this.answering.set(false);
    this.advancing.set(false);
    this.connectionLost.set(false);
    this.retryAction = null;
    this.finalResult = null;
    this.deadline = null;
    this.serverClock.set(false);
    this.questions.set([]);
    this.index.set(0);
    this.reveal.set(null);
    this.paused.set(false);
    this.secondsLeft.set(null);
    this.result.set(null);
  }

  // Shows the server's verdict on question `index` like the page judges a local one, and scores from it. A

  private startQuestionTimer(): void {
    this.remaining = this.limit ?? 0;
    this.secondsLeft.set(this.limit);
  }

  // "Tiếp" in a shared run: the result after the last question's verdict, else the next question. The view and
  // the reveal stay on screen until it arrives, so the game component is not recreated, and the question

  private timeUp(): void {
    this.inZone(() => {
      const play = this.current();
      if (!play || this.reveal() !== null || this.answering()) {
        return;
      }
      if (this.mode() === 'shared') {
        this.sendAnswer(null);
      } else {
        this.showReveal(play, timeoutReveal(play));
      }
    });
  }

  // What a failed request of a run in progress means. A final answer from the server ends the run one way or
  // another; a failure of the connection (after the service's own retries) keeps the screen, the question or its

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

  // `served` is the server's account of a shared run, which is what the result shows: it judged every answer.
  private finishRun(served: SharedStageResult | null = null): void {
    const quiz = this.quiz();
    if (!quiz) {
      return;
    }
    const total = served?.total ?? this.questions().length;
    const correct = served?.correct ?? this.correctCount;
    const stage = this.stage();
    // A preview keeps nothing, not even on this device: the verdict is worked out without writing progress,
    // and since every stage is open the next one is offered whether or not this run passed.
    const preview = this.mode() === 'preview';
    const percent = passPercentOf(this.assignmentPassPercents(), stage);
    let passed: boolean;
    if (served) {
      // The map's progress on this device follows the server's, which recorded the run itself.
      this.progress.record(quiz.key, stage, correct, total, percent);
      passed = served.passed;
    } else if (preview) {
      passed = correct >= passMark(total, percent);
    } else {
      passed = this.progress.record(quiz.key, stage, correct, total, percent);
    }
    this.result.set({
      stage,
      position: stagePosition(quiz.stages.keys(), stage),
      correct,
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
    if (served) {
      this.runId = null;
      this.finalResult = null;
      this.saveState.set('saved');
      // The leaderboard on the map may be on screen by the time the student is back there.
      this.boardKey.update(key => key + 1);
    }
    this.screen.set('result');
  }

  // The answers that end a shared run whatever it was doing: the assignment closed (410), it is gone (404 that is
  // not about the run), or the server does not know this student (403, which the service has forgotten already).

  private startSharedRun(): void {
    if (this.starting()) {
      return;
    }
    const stage = this.stage();
    this.resetRun();
    this.starting.set(true);
    this.watchRun(this.sharedPlay.startRun(this.shareCode(), stage), {
      next: start => {
        this.starting.set(false);
        this.beginSharedRun(start);
      },
      error: err => {
        this.starting.set(false);
        this.startFailed(err, stage);
      },
    });
  }

  private beginSharedRun(start: SharedRunStart): void {
    const stage = this.stage();
    this.runId = start.runId;
    this.runTotal.set(start.total);
    // The run counts toward the replay limit from the moment it starts, finished or not.
    this.attemptsUsed.update(used => ({
      ...used,
      [String(stage)]: start.attempts
    }));
    this.beginRun([sharedPlayQuestion(stage, start.question)]);
    this.startServerClock(start.question);
    this.screen.set('playing');
    this.prepareVision();
  }

  // was left or replaced (the map, another quiz, a newer run) is dropped.
  private watchRun<T>(source: Observable<T>, observer: {
    next: (value: T) => void;
    error: (err: unknown) => void
  }): void {
    const seq = this.runSeq;
    this.runRequest?.unsubscribe();
    this.runRequest = source.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: value => {
        if (seq === this.runSeq) {
          observer.next(value);
        }
      },
      error: err => {
        if (seq === this.runSeq) {
          observer.error(err);
        }
      },
    });
  }

  // Brings the progress and the runs of this device's student up to date from the server, quietly: nothing is

  // the game says (`deadline`).
  private startServerClock(question: SharedQuestion): void {
    const left = question.timeLeftMs;
    this.limit = left === null ? null : left / 1000;
    this.remaining = this.limit ?? 0;
    this.secondsLeft.set(this.limit === null ? null : Math.ceil(this.limit));
    this.deadline = left === null ? null : performance.now() + left + question.graceMs - DEADLINE_MARGIN_MS;
    this.serverClock.set(left !== null);
    if (left !== null) {
      // A pause taken during the verdict must not carry over: this question's clock is already running.
      this.paused.set(false);
    }
  }

  // further input and its clock stands still; the reveal waits for the server's verdict.
  private sendAnswer(choice: Choice | null): void {
    const runId = this.runId;
    if (runId === null) {
      return;
    }
    const index = this.index();
    this.answering.set(true);
    this.connectionLost.set(false);
    this.watchRun(this.sharedPlay.answer(this.shareCode(), runId, index, choice), {
      next: verdict => {
        this.answering.set(false);
        this.showVerdict(index, choice, verdict);
      },
      error: err => this.runRequestFailed(err, () => this.sendAnswer(choice)),
    });
  }

  // The runs `stage` has left for this student: null outside a shared quiz (a teacher's preview and a file are

  // verdict that says time was up is shown as a time-out even when a choice was sent with the answer.
  private showVerdict(index: number, choice: Choice | null, verdict: SharedVerdict): void {
    const asked = this.questions()[index];
    if (!asked) {
      return;
    }
    const judged = withVerdict(asked, verdict);
    this.questions.update(list => list.map((play, i) => (i === index ? judged : play)));
    this.finalResult = verdict.result;
    this.showReveal(judged, {
      chosen: verdict.timedOut ? null : choice,
      correct: verdict.correct,
      correctIndex: verdict.correctIndex ?? undefined,
      correctOrder: verdict.correctOrder ?? undefined,
    });
  }

  // Takes what the server says this student has used. A run counts the moment it starts and the answer to the

  // replaces them in one step.
  private nextShared(): void {
    if (this.advancing() || this.connectionLost()) {
      return;
    }
    if (this.finalResult) {
      this.finishRun(this.finalResult);
      return;
    }
    const runId = this.runId;
    if (runId === null) {
      return;
    }
    this.advancing.set(true);
    this.watchRun(this.sharedPlay.nextQuestion(this.shareCode(), runId), {
      next: question => {
        this.advancing.set(false);
        this.questions.update(list => [...list, sharedPlayQuestion(this.stage(), question)]);
        this.reveal.set(null);
        this.index.update(index => index + 1);
        this.startServerClock(question);
      },
      error: err => {
        this.advancing.set(false);
        this.runRequestFailed(err, () => this.nextShared());
      },
    });
  }

  // verdict, and offers "Thử lại", which sends the same request again.
  private runRequestFailed(err: unknown, retry: () => void): void {
    const { status } = failureOf(err);
    if (status === 0 || status >= 500) {
      this.retryAction = retry;
      this.connectionLost.set(true);
      return;
    }
    if (this.sharedEnded(err)) {
      return;
    }
    // The server has no such run, or it is over, or it refused the answer: the stage was started again in another
    // tab, or the page and the server are out of step. Nothing here can go on.
    this.backToMap();
    this.notificationService.warning(
      'Lượt chơi đã kết thúc',
      'Lượt chơi này đã kết thúc, có thể bạn đã bắt đầu màn này ở tab khác.',
      { nzPlacement: 'top' });
  }

  // What a failed start of a run means: the same final answers, and the two refusals that only a start can get.
  private startFailed(err: unknown, stage: number): void {
    if (this.sharedEnded(err)) {
      return;
    }
    const {
      status,
      body
    } = failureOf(err);
    if (status === 409 && body === 'Stage locked') {
      // This page thought the stage was open and the server knows better: the map is brought into step.
      this.backToMap();
      this.refreshSharedProgress();
      this.notificationService.warning('Màn này chưa mở', 'Hãy qua màn trước rồi chơi màn này nhé.', { nzPlacement: 'top' });
    } else if (status === 409 && body === 'Replay limit reached') {
      this.useUpAttempts(stage);
      this.backToMap();
      this.notificationService.warning('Hết lượt chơi', 'Bạn đã dùng hết lượt chơi màn này.', { nzPlacement: 'top' });
    } else {
      // Offline, or a failure the student can try again: the intro is where "Bắt đầu" is.
      this.screen.set('intro');
      this.notificationService.error(
        'Chưa bắt đầu được màn',
        status === 0 ? 'Mất kết nối. Hãy kiểm tra mạng rồi bấm Bắt đầu lại.' : 'Hãy thử bấm Bắt đầu lại.',
        { nzPlacement: 'top' });
    }
  }

  // Returns whether it was one of them.
  private sharedEnded(err: unknown): boolean {
    const {
      status,
      body
    } = failureOf(err);
    if (status === 410) {
      this.leaveRun();
      this.fail(SHARED_CLOSED);
    } else if (status === 403) {
      this.leaveRun();
      this.askToJoin();
    } else if (status === 404 && body !== RUN_NOT_FOUND) {
      this.leaveRun();
      this.fail(SHARED_MISSING);
    } else {
      return false;
    }
    return true;
  }

  // ---- The animation loop ----

  // Out of the run and off the camera, for a screen that is not the map.
  private leaveRun(): void {
    this.resetRun();
    this.vision.stopCamera();
  }

  // shown if it cannot be reached.
  private refreshSharedProgress(): void {
    this.watch(this.sharedPlay.load(this.shareCode()), {
      next: shared => {
        this.countAttempts(shared);
        this.syncProgress(shared);
      },
      error: () => undefined,
    });
  }

  // The question's clock: it only runs while the player can answer (nothing judged yet, no answer out, and a
  // face game's calibration finished, which is `ready`) and a time limit is on. A shared question also has the
  // server's clock, which waits for nothing: past its `deadline` time is up, ready or not, and the player is

  // Makes the progress kept on this device (which the stage map shows) the server's own for the student.
  private syncProgress(shared: SharedQuiz): void {
    const quiz = this.quiz();
    if (quiz && this.player()) {
      this.progress.replace(quiz.key, shared.results ?? {});
    }
  }

  // never limited) or when the teacher set no limit.
  private stageAttemptsLeft(stage: number): number | null {
    return this.mode() === 'shared'
      ? attemptsLeft(this.assignmentMaxAttempts(), this.attemptsUsed()[String(stage)])
      : null;
  }

  // Runs `action` inside Angular's zone, so the page is checked afterwards even when the caller is the

  // start says how many that makes, so the server's figure is the newest one this page can be given.
  private countAttempts(shared: SharedQuiz): void {
    this.attemptsUsed.set({ ...shared.attempts });
  }

  // ---- Camera ----

  private useUpAttempts(stage: number): void {
    const max = this.assignmentMaxAttempts();
    if (max !== null) {
      this.attemptsUsed.update(used => ({
        ...used,
        [String(stage)]: Math.max(max, used[String(stage)] ?? 0)
      }));
    }
  }

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

  // What a stage needs from the camera when it is opened: start it if the player had it on last time,

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
    } else if (!this.answering()) {
      this.runTimer(dt, now, game.ready());
    }
  }

  // shown the smaller of the two clocks.
  private runTimer(dt: number, now: number, ready: boolean): void {
    if (this.limit === null) {
      return;
    }
    if (ready) {
      this.remaining = Math.max(0, this.remaining - dt);
    }
    const untilDeadline = this.deadline === null ? Number.POSITIVE_INFINITY : (this.deadline - now) / 1000;
    const whole = Math.ceil(Math.max(0, Math.min(this.remaining, untilDeadline)));
    if (whole !== this.secondsLeft()) {
      this.inZone(() => this.secondsLeft.set(whole));
      if (whole > 0 && whole <= TICK_SECONDS) {
        this.audio.play('tick');
      }
    }
    if (this.remaining <= 0 || untilDeadline <= 0) {
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

  // Once this stage's model is ready and the camera is on, the other kind the quiz needs is fetched in
  // the background so changing stage does not wait for it. Never while playing: creating a model can

  // animation loop or a game that was driven from it.
  private inZone(action: () => void): void {
    if (NgZone.isInAngularZone()) {
      action();
    } else {
      this.zone.run(action);
    }
  }

  // ---- Keyboard, visibility and fullscreen ----

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

  // A hidden tab stops the animation frames anyway; pausing makes the player come back to a stopped

  // and make sure this stage's model (hand or face) is loaded.
  private prepareVision(): void {
    const state = this.vision.cameraState();
    if (state === 'on' || state === 'starting') {
      void this.loadModel(this.def().vision);
    } else if (state === 'off' && this.settings().useCamera) {
      void this.enableCamera();
    }
  }

  // A failed load is shown by the model chip and the notice; the quiz stays playable without it.
  private loadModel(kind: VisionKind): Promise<void> {
    return this.vision.ensureModel(kind).then(() => this.preloadOtherModels()).catch(() => undefined);
  }

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
}
