import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { NzModalComponent } from 'ng-zorro-antd/modal';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { BehaviorSubject, of, Subject, throwError } from 'rxjs';
import { DEMO_QUIZ_CSV } from '../../game/demo-quiz';
import { GameAudio } from '../../game/game-audio';
import { StageGameBase, VisionKind } from '../../game/stage-game';
import { passMark, STAGES } from '../../game/stages';
import { CameraState, ModelState, VisionService } from '../../game/vision.service';
import { AiJob } from '../../models/ai-job';
import {
  AssignmentDetail,
  passPercentOf,
  PlayerIdentity,
  SharedQuestion,
  SharedQuiz,
  SharedRunStart,
  SharedStageResult,
  SharedVerdict,
  StudentBoard,
} from '../../models/assignment';
import { ExportType } from '../../models/export-type';
import { GestureQuestion, parseGestureQuiz } from '../../models/gesture-quiz';
import { AiJobService } from '../../services/ai-job.service';
import { AssignmentService } from '../../services/assignment.service';
import { CsvImportService } from '../../services/csv-import.service';
import { SharedPlayService } from '../../services/shared-play.service';
import { timeLimitFor } from './gesture-engine';
import { GesturePlay } from './gesture-play';
import { TimeMode } from './gesture-settings.service';
import { ShareJoin } from './share-join/share-join';

const PROGRESS_KEY = 'gesture-quiz-progress';
const SETTINGS_KEY = 'gesture-quiz-settings';

// A camera and recognition stand-in: the page is tested here, not MediaPipe or a real webcam.
class FakeVision {
  readonly video = document.createElement('video');
  readonly cameraState = signal<CameraState>('off');
  readonly cameraMessage = signal('');
  readonly startCamera = jasmine.createSpy('startCamera').and.callFake(async () => this.cameraState.set('on'));
  readonly stopCamera = jasmine.createSpy('stopCamera').and.callFake(() => this.cameraState.set('off'));
  readonly detect = jasmine.createSpy('detect').and.returnValue(null);
  private readonly models = {
    hand: signal<ModelState>('idle'),
    face: signal<ModelState>('idle')
  };
  readonly ensureModel = jasmine
    .createSpy('ensureModel')
    .and.callFake(async (kind: VisionKind) => this.models[kind].set('ready'));

  modelState(kind: VisionKind) {
    return this.models[kind];
  }

  videoSize() {
    return {
      width: 640,
      height: 480
    };
  }
}

// The sample's rows of only some stages, the way a quiz made with a choice of games looks: the CSV keeps
// the stages' own numbers (4 and 6), so only what is shown is renumbered.
function sampleStages(...stages: number[]): string {
  return DEMO_QUIZ_CSV.split('\n').filter(line => stages.some(stage => line.startsWith(`${stage},`))).join('\n');
}

function gestureJob(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: 'job-1',
    status: 'done',
    title: 'HSK1 bài 1',
    creative: true,
    exportType: ExportType.GestureQuiz,
    intelligence: 1,
    imageCount: 0,
    courseType: null,
    courseName: '',
    hskStandard: null,
    level: null,
    lessonNumber: null,
    retryable: false,
    retryUntil: null,
    csv: DEMO_QUIZ_CSV,
    errorStatus: 0,
    errorMessage: '',
    createdAt: '2026-10-13T00:00:00Z',
    finishedAt: null, ...overrides,
  };
}

// A student's quiz and a teacher's assignment, both made of the sample's questions.
const CODE = 'ABC123DEF4';

// The seconds per question the server sends for a time mode. Here they are the page's own defaults with the mode
// applied, which is what the server's configuration gives unless it was changed: a spec that wants the server's
// to differ says so with its own `timeLimits`.
function timeLimitsFor(mode: TimeMode): Record<string, number | null> {
  return Object.fromEntries(STAGES.map(def => [String(def.stage), timeLimitFor(def.seconds, mode)]));
}

// What GET share/{code} says of the sample quiz: how many questions each stage has, and nothing of the questions.
function sharedQuiz(overrides: Partial<SharedQuiz> = {}): SharedQuiz {
  return {
    title: 'HSK1 bài 1',
    label: 'Lớp 6A',
    timeMode: 'standard',
    stageLock: 'sequential',
    passPercents: {
      '1': 70,
      '2': 70,
      '3': 70,
      '4': 70,
      '5': 70,
      '6': 70
    },
    maxAttempts: null,
    showBoard: true,
    stageCounts: {
      '1': 5,
      '2': 5,
      '3': 5,
      '4': 5,
      '5': 5,
      '6': 5
    },
    timeLimits: timeLimitsFor(overrides.timeMode ?? 'standard'),
    attempts: {},
    results: {},
    closesAt: null, ...overrides
  };
}

function assignmentDetail(overrides: Partial<AssignmentDetail> = {}): AssignmentDetail {
  return {
    id: 'a1',
    code: CODE,
    jobId: 'job-1',
    title: 'HSK1 bài 1',
    label: 'Lớp 6A',
    timeMode: 'standard',
    stageLock: 'sequential',
    passPercents: {
      '1': 70,
      '2': 70,
      '3': 70,
      '4': 70,
      '5': 70,
      '6': 70
    },
    maxAttempts: null,
    showBoard: true,
    stageCounts: {
      1: 5,
      2: 5,
      3: 5,
      4: 5,
      5: 5,
      6: 5
    },
    timeLimits: timeLimitsFor(overrides.timeMode ?? 'standard'),
    createdAt: '2026-10-14T00:00:00Z',
    closesAt: null,
    closedAt: null,
    open: true,
    playerCount: 0,
    csv: DEMO_QUIZ_CSV,
    players: [], ...overrides,
  };
}

const httpError = (status: number, body = '') =>
  throwError(() => new HttpErrorResponse({
    status,
    error: body || null
  }));

// What the leaderboard under the map reads: nobody has played, unless a spec says otherwise.
function studentBoard(overrides: Partial<StudentBoard> = {}): StudentBoard {
  return {
    top: [],
    you: null,
    possible: 30,
    stageCount: 6,
    playerCount: 0, ...overrides
  };
}

describe('GesturePlay', () => {
  let fixture: ComponentFixture<GesturePlay>;
  let vision: FakeVision;
  let audio: jasmine.SpyObj<GameAudio>;
  let notifications: jasmine.SpyObj<NzNotificationService>;
  let params: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
  let jobs: { jobs: ReturnType<typeof signal<AiJob[]>>; refresh: jasmine.Spy };
  let shared: jasmine.SpyObj<SharedPlayService>;
  let assignments: jasmine.SpyObj<AssignmentService>;
  // Who this device has joined the shared quiz as: the fake keeps it the way the service keeps it.
  let stored: PlayerIdentity | null;

  const demoQuiz = parseGestureQuiz(new CsvImportService().parseCsvRows(DEMO_QUIZ_CSV), 'Demo');

  // The server of a shared quiz, played by hand: it holds the sample's questions, deals them in the CSV's order
  // (the right option last, the sentence's pieces reversed), judges the answers it is sent and keeps the student's
  // runs started and best results, the way the real one does. `serve` sets it up for a quiz as GET share/{code}
  // describes it; a spec that needs the server to fail makes the spied method return an error instead.
  interface FakeRun {
    id: string;
    stage: number;
    items: GestureQuestion[];
    // How many questions have been answered, and how many of them rightly.
    answered: number;
    right: number;
  }

  let server: {
    quiz: SharedQuiz;
    started: Record<string, number>;
    results: Record<string, SharedStageResult>;
    runs: number;
    run: FakeRun | null;
  };

  const optionsOf = (item: GestureQuestion): string[] =>
    item.stage === 1 ? ['Đúng', 'Sai'] : item.chunks ? [] : [...item.wrong, item.correct];

  function dealt(run: FakeRun, index: number): SharedQuestion {
    const item = run.items[index];
    const limit = server.quiz.timeLimits[String(run.stage)];
    return {
      index,
      question: item.question,
      options: optionsOf(item),
      chunks: item.chunks ? [...item.chunks].reverse() : null,
      timeLeftMs: limit === null ? null : limit * 1000,
      graceMs: 5000,
    };
  }

  function serve(overrides: Partial<SharedQuiz> = {}): void {
    const quiz = sharedQuiz(overrides);
    server = {
      quiz,
      started: { ...quiz.attempts },
      results: { ...quiz.results },
      runs: 0,
      run: null
    };
  }

  // Starts a run of `stage` on the fake server: it counts toward the student's runs at once, and the first question
  // is dealt with it.
  function runStart(stage: number): SharedRunStart {
    const key = String(stage);
    server.started[key] = (server.started[key] ?? 0) + 1;
    server.runs += 1;
    server.run = {
      id: `run-${server.runs}`,
      stage,
      items: demoQuiz.stages.get(stage)!,
      answered: 0,
      right: 0
    };
    return {
      runId: server.run.id,
      stage,
      total: server.run.items.length,
      attempts: server.started[key],
      question: dealt(server.run, 0),
    };
  }

  const startOnServer = (_code: string, stage: number) => of(runStart(stage));

  const answerOnServer = (_code: string, _runId: string, index: number, choice: number | string[] | null) =>
    of(judgeOnServer(index, choice));

  function judgeOnServer(index: number, choice: number | string[] | null): SharedVerdict {
    const run = server.run!;
    const item = run.items[index];
    const options = optionsOf(item);
    const timedOut = choice === null;
    const correct = !timedOut && (item.chunks
      ? Array.isArray(choice) && choice.join('/') === item.chunks.join('/')
      : choice === options.indexOf(item.correct));
    run.answered = Math.max(run.answered, index + 1);
    run.right += correct ? 1 : 0;
    let result: SharedStageResult | null = null;
    if (index === run.items.length - 1) {
      const total = run.items.length;
      const passed = run.right >= passMark(total, passPercentOf(server.quiz.passPercents, run.stage));
      result = {
        correct: run.right,
        total,
        passed
      };
      const best = server.results[String(run.stage)];
      server.results[String(run.stage)] = {
        correct: Math.max(best?.correct ?? 0, run.right),
        total,
        passed: (best?.passed ?? false) || passed,
      };
    }
    return {
      correct,
      timedOut,
      correctIndex: item.chunks ? undefined : options.indexOf(item.correct),
      correctOrder: item.chunks ?? undefined,
      answer: item.correct,
      explanation: item.explanation,
      result,
    };
  }

  beforeEach(() => {
    localStorage.removeItem(PROGRESS_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    vision = new FakeVision();
    audio = jasmine.createSpyObj<GameAudio>('GameAudio', ['play', 'resume', 'setMuted']);
    notifications = jasmine.createSpyObj('NzNotificationService', ['warning', 'success', 'error']);
    params = new BehaviorSubject(convertToParamMap({}));
    jobs = {
      jobs: signal<AiJob[]>([]),
      refresh: jasmine.createSpy('refresh').and.returnValue(of([]))
    };
    stored = null;
    serve();
    shared = jasmine.createSpyObj<SharedPlayService>(
      'SharedPlayService',
      ['load', 'join', 'identity', 'forget', 'startRun', 'nextQuestion', 'answer', 'setAvatar', 'leaderboard']);
    shared.load.and.callFake(() => of({
      ...server.quiz,
      attempts: { ...server.started },
      results: { ...server.results }
    }));
    shared.startRun.and.callFake(startOnServer);
    shared.nextQuestion.and.callFake((_code: string, _runId: string) => of(dealt(server.run!, server.run!.answered)));
    shared.answer.and.callFake(answerOnServer);
    shared.identity.and.callFake(() => stored);
    shared.forget.and.callFake(() => {
      stored = null;
    });
    shared.join.and.callFake((_code: string, name: string, avatar = '') => {
      const identity: PlayerIdentity = {
        playerId: `p-${name.toLowerCase()}`,
        token: 'token',
        name,
        avatar
      };
      stored = identity;
      return of(identity);
    });
    shared.setAvatar.and.callFake((_code: string, avatar: string) => {
      stored = {
        ...stored!,
        avatar
      };
      return of(stored);
    });
    shared.leaderboard.and.callFake(() => of(studentBoard()));
    assignments = jasmine.createSpyObj<AssignmentService>('AssignmentService', ['get']);
    assignments.get.and.callFake(() => of(assignmentDetail()));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { paramMap: params }
        },
        {
          provide: VisionService,
          useValue: vision
        },
        {
          provide: GameAudio,
          useValue: Object.assign(audio, { muted: signal(false) })
        },
        {
          provide: NzNotificationService,
          useValue: notifications
        },
        {
          provide: AiJobService,
          useValue: jobs
        },
        {
          provide: SharedPlayService,
          useValue: shared
        },
        {
          provide: AssignmentService,
          useValue: assignments
        },
      ],
    });
  });

  afterEach(() => {
    fixture?.destroy();
    localStorage.removeItem(PROGRESS_KEY);
    localStorage.removeItem(SETTINGS_KEY);
  });

  function open(): void {
    fixture = TestBed.createComponent(GesturePlay);
    fixture.detectChanges();
  }

  const element = (): HTMLElement => fixture.nativeElement;
  const text = (): string => element().textContent ?? '';

  function click(selector: string, label?: string): void {
    const candidates = Array.from(element().querySelectorAll<HTMLElement>(selector));
    const target = label ? candidates.find(candidate => candidate.textContent?.includes(label)) : candidates[0];
    if (!target) {
      throw new Error(`Nothing to click: ${selector} ${label ?? ''}`);
    }
    target.click();
    fixture.detectChanges();
  }

  // Lets the camera's promises finish. `whenStable` is no use here: the icons' requests stay pending in the
  // HTTP testing backend, and a pending request keeps the application unstable for good.
  async function settle(): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve));
    fixture.detectChanges();
  }

  function playDemo(): void {
    open();
    click('button', 'Chơi thử quiz mẫu');
  }

  function game(): StageGameBase {
    // StageGameBase is abstract, which By.directive's type does not accept, though it matches provider tokens.
    const token = StageGameBase as unknown as Type<StageGameBase>;
    return fixture.debugElement.query(By.directive(token)).injector.get(token);
  }

  // The choice that is right for the question on screen, whatever order the options were shuffled in.
  function rightChoice(): number | string[] {
    const view = game().question();
    const source = demoQuiz.stages.get(view.stage)!.find(candidate => candidate.question === view.question)!;
    return source.chunks ?? view.options.indexOf(source.correct);
  }

  function wrongChoice(): number {
    return 1 - (rightChoice() as number);
  }

  // An answer that is wrong for the question on screen, whichever game it is (stage 6 wants the chunks in
  // order, the others an option).
  function anyWrongChoice(): number | string[] {
    const right = rightChoice();
    return Array.isArray(right) ? [...right].reverse() : (right + 1) % game().question().options.length;
  }

  // Plays the stage whose card says `label` through the page: `choose` is what the stage's game emits.
  function playStage(label: string, answer: () => number | string[]): void {
    click('.stage-card', label);
    click('button', 'Bắt đầu');
    for (let question = 0; question < 5; question += 1) {
      game().choose.emit(answer());
      fixture.detectChanges();
      click('button', 'Tiếp');
    }
  }

  function playStageOne(answer: () => number | string[]): void {
    playStage('Màn 1', answer);
  }

  // Opens the page on an AI job whose quiz has only the given stages of the sample.
  function openStages(...stages: number[]): void {
    jobs.jobs.set([gestureJob({ csv: sampleStages(...stages) })]);
    params.next(convertToParamMap({ jobId: 'job-1' }));
    open();
  }

  const cardList = (): HTMLButtonElement[] =>
    Array.from(element().querySelectorAll<HTMLButtonElement>('.stage-card'));
  const normalized = (selector: string): string =>
    (element().querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();

  describe('loading a quiz', () => {
    it('starts on the load screen with the file picker, the sample and the guide', () => {
      open();

      expect(text()).toContain('Mở file quiz');
      expect(text()).toContain('Chơi thử quiz mẫu');
      expect(element().querySelector('app-usage-guide')).not.toBeNull();
      expect(element().querySelector('input[type="file"]')?.getAttribute('accept')).toContain('.csv');
    });

    it('has no leaderboard and no avatar, which belong to an assignment', () => {
      playDemo();

      expect(element().querySelector('app-student-leaderboard')).toBeNull();
      expect(element().querySelector('.avatar-button')).toBeNull();
      expect(shared.leaderboard).not.toHaveBeenCalled();
    });

    it('opens the sample quiz as a map of six stages with only the first one open', () => {
      playDemo();

      const cards = Array.from(element().querySelectorAll<HTMLButtonElement>('.stage-card'));
      expect(cards.length).toBe(6);
      expect(cards.map(card => card.disabled)).toEqual([false, true, true, true, true, true]);
      expect(text()).toContain('Quiz mẫu HSK 1');
      expect(text()).toContain('Đang mở');
      expect(text()).toContain('Khóa');
      expect(cards.map(card => card.querySelector('.stage-no')?.textContent))
        .toEqual(['Màn 1', 'Màn 2', 'Màn 3', 'Màn 4', 'Màn 5', 'Màn 6']);
      expect(normalized('.summary')).toBe(
        '6 màn, 30 câu, từ dễ đến khó. Đúng từ 70% số câu để mở màn sau.');
    });

    it('plays an AI job from its id', () => {
      jobs.jobs.set([gestureJob()]);
      params.next(convertToParamMap({ jobId: 'job-1' }));
      open();

      expect(text()).toContain('HSK1 bài 1');
      expect(element().querySelectorAll('.stage-card').length).toBe(6);
      expect(jobs.refresh).not.toHaveBeenCalled();
    });

    it('asks for the jobs once when the job is not known yet', () => {
      jobs.refresh.and.callFake(() => {
        jobs.jobs.set([gestureJob()]);
        return of([gestureJob()]);
      });
      params.next(convertToParamMap({ jobId: 'job-1' }));
      open();

      expect(jobs.refresh).toHaveBeenCalledTimes(1);
      expect(element().querySelectorAll('.stage-card').length).toBe(6);
    });

    it('shows an error card with a way back for a missing, unfinished or other-platform job', () => {
      const cases: [AiJob[], string][] = [
        [[], 'Không tìm thấy'],
        [[gestureJob({ status: 'running' })], 'đang tạo'],
        [[gestureJob({ status: 'failed' })], 'không thành công'],
        [[gestureJob({ exportType: ExportType.Wayground })], 'không phải game'],
        [[gestureJob({ csv: 'không phải quiz' })], 'Không tìm thấy câu hỏi'],
      ];
      for (const [list, message] of cases) {
        jobs.jobs.set(list);
        params.next(convertToParamMap({ jobId: 'job-1' }));
        open();

        expect(text()).withContext(message).toContain(message);
        expect(element().querySelector('a[href="/ai-history"].ant-btn-primary')).withContext(message).not.toBeNull();
        expect(element().querySelectorAll('.stage-card').length).toBe(0);
        fixture.destroy();
      }
    });

    it('warns about rows that were left out', () => {
      jobs.jobs.set([gestureJob({ csv: `${DEMO_QUIZ_CSV}\n9,không phải câu hỏi,x` })]);
      params.next(convertToParamMap({ jobId: 'job-1' }));
      open();

      expect(notifications.warning).toHaveBeenCalledTimes(1);
      expect(notifications.warning.calls.mostRecent().args[1]).toContain('1 dòng');
      expect(notifications.warning.calls.mostRecent().args[2]).toEqual({ nzPlacement: 'top' });
    });
  });

  describe('playing a stage', () => {
    it('shows the intro, then the stage with the game of that stage', () => {
      playDemo();
      click('.stage-card', 'Màn 1');

      expect(text()).toContain('Màn 1');
      expect(text()).toContain('Đúng hay sai');
      expect(text()).toContain('Camera chỉ xử lý trên máy này');
      expect(text()).toContain('Đúng ít nhất 4/5');

      click('button', 'Bắt đầu');

      expect(audio.play).toHaveBeenCalledWith('start');
      expect(element().querySelector('app-true-false-game')).not.toBeNull();
      expect(game().question().stage).toBe(1);
      expect(game().question().options).toEqual(['Đúng', 'Sai']);
      expect(text()).toContain('Câu 1/5');
    });

    it('judges the game\'s choice once, scores it and shows the answer and the explanation', () => {
      playDemo();
      click('.stage-card', 'Màn 1');
      click('button', 'Bắt đầu');

      const choice = rightChoice();
      game().choose.emit(choice);
      game().choose.emit(wrongChoice());
      fixture.detectChanges();

      expect(text()).toContain('Chính xác! +10');
      expect(text()).toContain('⭐ 10');
      expect(text()).toContain('Đáp án:');
      expect(game().reveal()).toEqual(jasmine.objectContaining({
        chosen: choice,
        correct: true,
        correctIndex: choice as number
      }));
      expect(audio.play).toHaveBeenCalledWith('correct', 1);
      expect(audio.play).not.toHaveBeenCalledWith('wrong');
    });

    it('shows a wrong answer with the right one and keeps the streak at zero', () => {
      playDemo();
      click('.stage-card', 'Màn 1');
      click('button', 'Bắt đầu');

      game().choose.emit(wrongChoice());
      fixture.detectChanges();

      expect(text()).toContain('Chưa đúng');
      expect(text()).toContain('⭐ 0');
      expect(audio.play).toHaveBeenCalledWith('wrong');
    });

    it('moves on with the Tiếp button and with Enter, but not while paused', () => {
      playDemo();
      click('.stage-card', 'Màn 1');
      click('button', 'Bắt đầu');

      game().choose.emit(rightChoice());
      fixture.detectChanges();
      click('button', 'Tiếp');
      expect(text()).toContain('Câu 2/5');
      expect(game().reveal()).toBeNull();

      game().choose.emit(rightChoice());
      fixture.detectChanges();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
      fixture.detectChanges();
      expect(text()).toContain('Tạm dừng');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();
      expect(text()).toContain('Câu 2/5');

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();
      expect(text()).toContain('Câu 3/5');
    });

    it('ignores a choice while paused', () => {
      playDemo();
      click('.stage-card', 'Màn 1');
      click('button', 'Bắt đầu');

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'P' }));
      fixture.detectChanges();
      game().choose.emit(rightChoice());
      fixture.detectChanges();

      expect(game().paused()).toBeTrue();
      expect(game().reveal()).toBeNull();
      expect(text()).toContain('Chơi tiếp');
    });

    it('passes a stage with every answer right, unlocks the next one and remembers it', () => {
      playDemo();
      playStageOne(rightChoice);

      expect(text()).toContain('Qua màn 1!');
      expect(text()).toContain('5/5');
      expect(text()).toContain('50 điểm');
      expect(text()).toContain('Màn tiếp theo');
      expect(audio.play).toHaveBeenCalledWith('finish');
      expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!)[demoQuiz.key].passed).toEqual([1]);

      click('button', 'Về bản đồ');

      const cards = Array.from(element().querySelectorAll<HTMLButtonElement>('.stage-card'));
      expect(cards.map(card => card.disabled)).toEqual([false, false, true, true, true, true]);
      expect(text()).toContain('Đã qua');
    });

    it('fails a stage below the pass mark, lists the missed questions and keeps the next one locked', () => {
      playDemo();
      playStageOne(wrongChoice);

      expect(text()).toContain('Chưa qua màn 1');
      expect(text()).toContain('Đúng ít nhất 4/5');
      expect(text()).toContain('Những câu cần xem lại');
      expect(element().querySelectorAll('.missed li').length).toBe(5);
      expect(text()).not.toContain('Màn tiếp theo');
      expect(audio.play).toHaveBeenCalledWith('wrong');

      click('button', 'Về bản đồ');

      expect(Array.from(element().querySelectorAll<HTMLButtonElement>('.stage-card')).map(card => card.disabled))
        .toEqual([false, true, true, true, true, true]);
    });

    it('replays a stage from the result screen with a fresh run', () => {
      playDemo();
      playStageOne(wrongChoice);

      click('button', 'Chơi lại màn');

      expect(text()).toContain('Câu 1/5');
      expect(text()).toContain('⭐ 0');
    });

    it('opens the next stage\'s intro from the result and plays its own game', () => {
      playDemo();
      playStageOne(rightChoice);

      click('button', 'Màn tiếp theo');
      expect(text()).toContain('Nghiêng đầu');
      click('button', 'Bắt đầu');

      expect(element().querySelector('app-head-tilt-game')).not.toBeNull();
      expect(game().question().stage).toBe(2);
      expect(game().question().options.length).toBe(2);
    });

    it('shows the final celebration once every stage is passed', () => {
      // Everything in the sample is marked passed straight in the store, before the page reads it.
      const stages = [1, 2, 3, 4, 5, 6];
      localStorage.setItem(
        PROGRESS_KEY,
        JSON.stringify({
          [demoQuiz.key]: {
            passed: stages,
            best: Object.fromEntries(stages.map(stage => [stage, {
              correct: 5,
              total: 5
            }])),
          },
        }),
      );
      playDemo();

      expect(text()).toContain('Chúc mừng');
      expect(text()).toContain('Tổng điểm tốt nhất: 300');
    });
  });

  // A quiz holds any 1 to 6 of the six stages; the CSV and the progress keep the stages' own numbers, and the
  // player reads them as "Màn 1", "Màn 2"… in the order they are played.
  describe('a quiz with only some of the stages', () => {
    const only46 = parseGestureQuiz(new CsvImportService().parseCsvRows(sampleStages(4, 6)), 'Demo');

    it('shows a card for each stage it has, numbered by position, and no card for the others', () => {
      openStages(4, 6);

      expect(cardList().length).toBe(2);
      expect(cardList().map(card => card.querySelector('.stage-no')?.textContent)).toEqual(['Màn 1', 'Màn 2']);
      expect(cardList().map(card => card.querySelector('.stage-name')?.textContent)).toEqual(['Chém hoa quả', 'Xếp câu']);
      expect(text()).not.toContain('Không có câu');
      expect(text()).not.toContain('Đúng hay sai');
      expect(text()).not.toContain('Màn 3');
    });

    it('says how many stages and questions it has', () => {
      openStages(4, 6);

      expect(normalized('.summary')).toBe(
        '2 màn, 10 câu, từ dễ đến khó. Đúng từ 70% số câu để mở màn sau.');
    });

    it('opens the first stage it has and keeps the second locked until the first is passed', () => {
      openStages(4, 6);

      expect(cardList().map(card => card.disabled)).toEqual([false, true]);

      playStage('Màn 1', rightChoice);
      click('button', 'Về bản đồ');

      expect(cardList().map(card => card.disabled)).toEqual([false, false]);
      // Progress is kept under the stage's own number (4), not its position.
      expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!)[only46.key].passed).toEqual([4]);
    });

    it('does not let a failed first stage open the second', () => {
      openStages(4, 6);

      playStage('Màn 1', anyWrongChoice);
      click('button', 'Về bản đồ');

      expect(cardList().map(card => card.disabled)).toEqual([false, true]);
    });

    it('shows the first stage as Màn 1 in the intro and the HUD', () => {
      openStages(4, 6);

      click('.stage-card', 'Màn 1');
      expect(normalized('.eyebrow')).toBe('Màn 1');
      expect(text()).toContain('Chém hoa quả');

      click('button', 'Bắt đầu');
      expect(normalized('.stage-pill')).toBe('🍉 Màn 1');
      expect(game().question().stage).toBe(4);
    });

    it('shows the position in the intro and the HUD of the second stage, and plays that stage\'s game', () => {
      openStages(4, 6);
      playStage('Màn 1', rightChoice);

      click('button', 'Màn tiếp theo');

      expect(normalized('.eyebrow')).toBe('Màn 2');
      expect(text()).toContain('Xếp câu');
      expect(text()).not.toContain('Màn 6');

      click('button', 'Bắt đầu');

      expect(normalized('.stage-pill')).toBe('🧩 Màn 2');
      expect(element().querySelector('app-word-order-game')).not.toBeNull();
      expect(game().question().stage).toBe(6);
    });

    it('names the stage by its position on the result of a pass', () => {
      openStages(4, 6);
      playStage('Màn 1', rightChoice);
      click('button', 'Màn tiếp theo');

      click('button', 'Bắt đầu');
      for (let question = 0; question < 5; question += 1) {
        game().choose.emit(rightChoice());
        fixture.detectChanges();
        click('button', 'Tiếp');
      }

      expect(normalized('.verdict')).toBe('Qua màn 2!');
      expect(text()).toContain('Xếp câu');
      expect(text()).toContain('Bạn đã qua hết các màn của quiz này.');
      expect(text()).not.toContain('Màn tiếp theo');
      expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!)[only46.key].passed).toEqual([4, 6]);
    });

    it('names the stage by its position on the result of a failed run', () => {
      openStages(4, 6);
      playStage('Màn 1', rightChoice);
      click('button', 'Về bản đồ');

      playStage('Màn 2', anyWrongChoice);

      expect(normalized('.verdict')).toBe('Chưa qua màn 2');
      expect(text()).toContain('Xếp câu');
      expect(text()).not.toContain('Màn 6');
    });

    it('celebrates when the stages it has are passed, though the others never were', () => {
      localStorage.setItem(
        PROGRESS_KEY,
        JSON.stringify({
          [only46.key]: {
            passed: [4, 6],
            best: {
              4: {
                correct: 5,
                total: 5
              },
              6: {
                correct: 4,
                total: 5
              }
            },
          },
        }),
      );
      openStages(4, 6);

      expect(text()).toContain('Chúc mừng');
      expect(text()).toContain('Tổng điểm tốt nhất: 90');
    });

    it('puts the stages in the order of their numbers, whatever the order of the rows', () => {
      const reversed = sampleStages(4, 6).split('\n').reverse().join('\n');
      jobs.jobs.set([gestureJob({ csv: reversed })]);
      params.next(convertToParamMap({ jobId: 'job-1' }));
      open();

      expect(cardList().map(card => card.querySelector('.stage-name')?.textContent)).toEqual(['Chém hoa quả', 'Xếp câu']);
      expect(cardList().map(card => card.disabled)).toEqual([false, true]);
    });

    it('describes a quiz of one stage as one stage, with the pass rule in its own words', () => {
      openStages(5);

      expect(cardList().length).toBe(1);
      expect(normalized('.stage-no')).toBe('Màn 1');
      expect(normalized('.stage-name')).toBe('Giơ ngón tay');
      expect(cardList()[0].disabled).toBeFalse();
      expect(normalized('.summary')).toBe('1 màn, 5 câu. Đúng từ 70% số câu là qua màn.');
      expect(text()).not.toContain('chơi từ dễ đến khó');
      expect(text()).not.toContain('Khóa');
    });

    it('plays a quiz of one stage and calls it Màn 1 all the way', () => {
      openStages(5);

      playStage('Màn 1', rightChoice);

      expect(normalized('.verdict')).toBe('Qua màn 1!');
      expect(text()).not.toContain('Màn tiếp theo');
      expect(text()).toContain('Bạn đã qua hết các màn của quiz này.');
    });

    it('lets the teacher preview every stage of an assignment that has only some', () => {
      assignments.get.and.returnValue(of(assignmentDetail({
        csv: sampleStages(4, 6),
        stageCounts: {
          4: 5,
          6: 5
        },
      })));
      params.next(convertToParamMap({ assignmentId: 'a1' }));
      open();

      expect(cardList().map(card => card.querySelector('.stage-no')?.textContent)).toEqual(['Màn 1', 'Màn 2']);
      expect(cardList().map(card => card.disabled)).toEqual([false, false]);

      click('.stage-card', 'Màn 2');
      expect(normalized('.eyebrow')).toBe('Màn 2');
      click('button', 'Bắt đầu');
      expect(game().question().stage).toBe(6);
    });

    it('does not claim in the guide that a quiz always has six stages', () => {
      open();
      // The guide's text is in a popup, which exists only once it is opened.
      click('.guide-button');

      const guide = document.querySelector('.usage-guide')?.textContent ?? '';
      expect(guide).not.toContain('6 màn');
    });
  });

  describe('camera', () => {
    it('starts the camera and this stage\'s model together and remembers the choice', async () => {
      playDemo();
      click('.stage-card', 'Màn 1');

      click('button', 'Bật camera');
      await settle();

      expect(vision.startCamera).toHaveBeenCalled();
      expect(vision.ensureModel).toHaveBeenCalledWith('hand');
      expect(audio.resume).toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).useCamera).toBeTrue();
      expect(element().querySelector('.preview video')).toBe(vision.video);
    });

    it('puts the camera picture into the stage and tells the game the camera is active', async () => {
      playDemo();
      click('.stage-card', 'Màn 1');
      click('button', 'Bật camera');
      await settle();
      click('button', 'Bắt đầu');
      fixture.detectChanges();

      expect(element().querySelector('.stage > video')).toBe(vision.video);
      expect(game().cameraActive()).toBeTrue();
      expect(text()).toContain('Nhận diện sẵn sàng');
      expect(text()).toContain('Đưa tay vào khung hình');
    });

    it('does not tell the game the camera is active until the stage\'s model is ready', async () => {
      vision.ensureModel.and.callFake(() => new Promise<void>(() => undefined));
      playDemo();
      click('.stage-card', 'Màn 1');
      click('button', 'Bật camera');
      await settle();
      click('button', 'Bắt đầu');
      fixture.detectChanges();

      expect(vision.cameraState()).toBe('on');
      expect(game().cameraActive()).toBeFalse();
    });

    it('keeps playing with the mouse when the model cannot be loaded', async () => {
      vision.ensureModel.and.callFake(async (kind: VisionKind) => {
        throw new Error(`no ${kind}`);
      });
      playDemo();
      click('.stage-card', 'Màn 1');
      click('button', 'Bật camera');
      await settle();
      click('button', 'Bắt đầu');

      expect(game().cameraActive()).toBeFalse();
      game().choose.emit(rightChoice());
      fixture.detectChanges();
      expect(text()).toContain('Chính xác');
    });

    it('does not remember a camera that could not be started', async () => {
      vision.startCamera.and.callFake(async () => {
        vision.cameraState.set('denied');
        vision.cameraMessage.set('Quyền dùng camera đã bị từ chối.');
      });
      playDemo();
      click('.stage-card', 'Màn 1');

      click('button', 'Bật camera');
      await settle();

      expect(text()).toContain('Quyền dùng camera đã bị từ chối.');
      expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).useCamera).toBeFalse();
    });

    it('starts the camera by itself on the next stage when it was on last time', async () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        timeMode: 'standard',
        sound: true,
        useCamera: true
      }));
      playDemo();
      expect(vision.startCamera).not.toHaveBeenCalled();

      click('.stage-card', 'Màn 1');
      await settle();

      expect(vision.startCamera).toHaveBeenCalledTimes(1);
    });

    it('turns the camera off when leaving to the map and when the page is destroyed', () => {
      playDemo();
      click('.stage-card', 'Màn 1');
      click('button', 'Về bản đồ');
      expect(vision.stopCamera).toHaveBeenCalledTimes(1);

      fixture.destroy();
      expect(vision.stopCamera).toHaveBeenCalledTimes(2);
    });
  });

  describe('settings', () => {
    it('uses the stage seconds by default', () => {
      playDemo();
      click('.stage-card', 'Màn 1');

      expect(text()).toContain('12 giây mỗi câu');
    });

    it('gives half as long again in extra-time mode', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        timeMode: 'extra',
        sound: true,
        useCamera: false
      }));
      playDemo();
      click('.stage-card', 'Màn 1');

      expect(text()).toContain('18 giây mỗi câu');
    });

    it('has no limit in unlimited mode', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        timeMode: 'unlimited',
        sound: true,
        useCamera: false
      }));
      playDemo();
      click('.stage-card', 'Màn 1');
      expect(text()).toContain('không giới hạn thời gian');

      click('button', 'Bắt đầu');
      expect(text()).toContain('⏱ ∞');
    });

    it('mutes the shared audio when the sound was turned off last time', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        timeMode: 'standard',
        sound: false,
        useCamera: false
      }));
      open();

      expect(audio.setMuted).toHaveBeenCalledWith(true);
    });
  });

  // A student on /play/s/:code. `stored` is who this device joined the quiz as before, if anyone.
  describe('a shared quiz (a student)', () => {
    const SAVED_KEY = `asg:${CODE}:p-lan`;
    const lan: PlayerIdentity = {
      playerId: 'p-lan',
      token: 'token',
      name: 'Lan',
      avatar: 'cat'
    };

    function openShared(identity: PlayerIdentity | null = null): void {
      stored = identity;
      // The link's code may be typed in lower case: it is read case-insensitively.
      params.next(convertToParamMap({ code: CODE.toLowerCase() }));
      open();
    }

    function joinAs(name: string, avatar = 'cat'): void {
      fixture.debugElement.query(By.directive(ShareJoin)).componentInstance.join.emit({
        name,
        avatar
      });
      fixture.detectChanges();
    }

    // The student's line above the map, and the parts of it.
    const shareLine = (): string =>
      Array.from(element().querySelector('.share-line')?.children ?? []).map(part => part.textContent?.trim()).join(' ');
    const avatarButton = (): HTMLButtonElement | null => element().querySelector('.avatar-button');

    const stageCards = (): HTMLButtonElement[] =>
      Array.from(element().querySelectorAll<HTMLButtonElement>('.stage-card'));

    describe('opening and joining', () => {
      it('asks a new device for a name before showing the quiz', () => {
        openShared();

        expect(shared.load).toHaveBeenCalledWith(CODE);
        expect(element().querySelector('app-share-join')).not.toBeNull();
        expect(text()).toContain('HSK1 bài 1');
        expect(text()).toContain('Lớp 6A');
        expect(stageCards().length).toBe(0);
      });

      it('joins with the name given and goes to the map, naming the student', () => {
        openShared();

        joinAs('Lan');

        expect(shared.join).toHaveBeenCalledWith(CODE, 'Lan', 'cat');
        expect(element().querySelector('app-share-join')).toBeNull();
        expect(stageCards().length).toBe(6);
        expect(shareLine()).toContain('Lan · Không phải bạn?');
      });

      it('skips the join screen on a device that has joined', () => {
        openShared(lan);

        expect(element().querySelector('app-share-join')).toBeNull();
        expect(stageCards().length).toBe(6);
        expect(shareLine()).toContain('Lan');
      });

      it('builds the map from the stage counts alone: the server sends no questions', () => {
        serve({
          stageCounts: {
            '2': 7,
            '4': 3
          }
        });
        openShared(lan);

        expect(stageCards().map(card => card.querySelector('.stage-no')?.textContent)).toEqual(['Màn 1', 'Màn 2']);
        expect(stageCards().map(card => card.querySelector('.stage-name')?.textContent)).toEqual(['Nghiêng đầu', 'Chém hoa quả']);
        expect(stageCards().map(card => card.disabled)).toEqual([false, true]);
        expect(normalized('.summary')).toContain('2 màn, 10 câu');
        click('.stage-card', 'Màn 1');
        expect(text()).toContain('7 câu');
      });

      it('shows the join screen of a quiz that has stages before anyone has joined', () => {
        serve({ stageCounts: { '3': 4 } });
        openShared();

        expect(element().querySelector('app-share-join')).not.toBeNull();
        expect(text()).toContain('HSK1 bài 1');
      });

      it('says the quiz has nothing to play when the server counts no questions, or none that make a stage', () => {
        const counts: Record<string, number>[] = [{}, {
          '0': 5,
          '7': 5,
          x: 5,
          '2': 0,
          '3': -1,
          '4': 2.5
        }];
        for (const stageCounts of counts) {
          serve({ stageCounts });
          openShared(lan);

          expect(text()).withContext(JSON.stringify(stageCounts)).toContain('Bài này chưa có câu hỏi nào chơi được. Hãy báo thầy cô.');
          expect(stageCards().length).toBe(0);
          expect(element().querySelector('main a')).toBeNull();
          fixture.destroy();
        }
      });

      it('makes the progress of the device the one the server holds for the student', () => {
        // An earlier visit left a pass the server does not know of (it was only on this device).
        localStorage.setItem(PROGRESS_KEY, JSON.stringify({
          [SAVED_KEY]: {
            passed: [1, 2],
            best: {
              1: {
                correct: 5,
                total: 5
              },
              2: {
                correct: 5,
                total: 5
              }
            }
          },
        }));
        serve({
          results: {
            '1': {
              correct: 4,
              total: 5,
              passed: true
            },
            '2': {
              correct: 2,
              total: 5,
              passed: false
            }
          }
        });
        openShared(lan);

        expect(stageCards().map(card => card.disabled)).toEqual([false, false, true, true, true, true]);
        expect(stageCards()[0].textContent).toContain('Đã qua');
        expect(stageCards()[1].textContent).not.toContain('Đã qua');
        expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!)[SAVED_KEY]).toEqual({
          passed: [1],
          best: {
            1: {
              correct: 4,
              total: 5
            },
            2: {
              correct: 2,
              total: 5
            }
          },
        });
      });

      it('shows a device the server does not know as the student with nothing passed', () => {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify({
          [SAVED_KEY]: {
            passed: [1],
            best: {}
          }
        }));
        openShared(lan);

        expect(stageCards().map(card => card.disabled)).toEqual([false, true, true, true, true, true]);
      });

      it('shows a taken name as an error under the field and stays on the join screen', () => {
        openShared();
        shared.join.and.returnValue(httpError(409, 'Name taken'));

        joinAs('Lan');

        expect(text()).toContain('Tên này đã có bạn dùng, hãy thêm họ hoặc số.');
        expect(element().querySelector('app-share-join [role="alert"]')).not.toBeNull();
        expect(stageCards().length).toBe(0);
      });

      it('explains the other reasons a join can fail', () => {
        const cases: [number, string, string][] = [
          [409, 'Assignment is full', 'Bài đã đủ số học sinh, hãy báo thầy cô.'],
          [400, 'Invalid name.', 'Tên cần từ 1 đến 40 ký tự.'],
          [0, '', 'Mất kết nối, hãy thử lại.'],
        ];
        openShared();
        for (const [status, body, message] of cases) {
          shared.join.and.returnValue(httpError(status, body));
          joinAs('Lan');

          expect(text()).withContext(message).toContain(message);
          expect(element().querySelector('app-share-join')).withContext(message).not.toBeNull();
        }
      });

      it('shows the closed card when the quiz closes while the student is joining', () => {
        openShared();
        shared.join.and.returnValue(httpError(410, 'Assignment closed'));

        joinAs('Lan');

        expect(text()).toContain('Bài này đã đóng. Cảm ơn bạn đã tham gia!');
        expect(element().querySelector('app-share-join')).toBeNull();
      });

      it('goes back to the join screen from "Không phải bạn?" and forgets the student', () => {
        openShared(lan);

        click('a', 'Không phải bạn?');

        expect(shared.forget).toHaveBeenCalledWith(CODE);
        expect(element().querySelector('app-share-join')).not.toBeNull();
        expect(stageCards().length).toBe(0);
      });
    });

    describe('when the quiz cannot be opened', () => {
      it('says the quiz is closed, with no way into the app', () => {
        shared.load.and.returnValue(httpError(410, 'Assignment closed'));
        openShared();

        expect(text()).toContain('Bài này đã đóng. Cảm ơn bạn đã tham gia!');
        expect(element().querySelector('main a')).toBeNull();
        expect(element().querySelector('.back-link')).toBeNull();
        expect(stageCards().length).toBe(0);
      });

      it('says the link is wrong for an unknown code', () => {
        shared.load.and.returnValue(httpError(404, 'Assignment not found'));
        openShared();

        expect(text()).toContain('Không tìm thấy bài này. Hãy kiểm tra lại link thầy cô gửi.');
        expect(element().querySelector('main a')).toBeNull();
      });

      it('asks for a reload on any other failure', () => {
        shared.load.and.returnValue(httpError(0));
        openShared();

        expect(text()).toContain('Không tải được bài. Hãy kiểm tra mạng rồi tải lại trang.');
        expect(element().querySelector('main a')).toBeNull();
      });
    });

    describe('the map and the topbar', () => {
      it('has no way out and names the quiz and its class', () => {
        openShared(lan);

        expect(element().querySelector('.back-link')).toBeNull();
        expect(element().querySelector('.title')?.textContent).toContain('HSK1 bài 1 · Lớp 6A');
        expect(text()).not.toContain('Mở quiz khác');
      });

      it('shows when the quiz closes', () => {
        shared.load.and.returnValue(of(sharedQuiz({ closesAt: new Date(2026, 9, 14, 21, 30).toISOString() })));
        openShared(lan);

        expect(text()).toContain('Bài đóng lúc 21:30 14/10');
      });

      it('leaves the closing time out when there is none', () => {
        openShared(lan);

        expect(text()).not.toContain('Bài đóng lúc');
      });

      it('shows the teacher\'s time mode as text, without the time radios or the reset', () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
          timeMode: 'standard',
          sound: true,
          useCamera: false
        }));
        shared.load.and.returnValue(of(sharedQuiz({ timeMode: 'extra' })));
        openShared(lan);

        expect(text()).toContain('Thời gian mỗi câu: Thêm thời gian (×1.5)');
        expect(element().querySelector('nz-radio-group')).toBeNull();
        expect(element().querySelector('.reset-button')).toBeNull();
        // The sound switch is the student's own.
        expect(element().querySelector('nz-switch')).not.toBeNull();
      });

      it('times the questions by the teacher\'s time mode, not the student\'s own', () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
          timeMode: 'unlimited',
          sound: true,
          useCamera: false
        }));
        shared.load.and.returnValue(of(sharedQuiz({ timeMode: 'extra' })));
        openShared(lan);

        click('.stage-card', 'Màn 1');

        expect(text()).toContain('18 giây mỗi câu');
      });

      // The seconds are the server's, from its configuration: they need not be the table's (12, 12, 15, 15, 20, 45).
      describe("the server's time limits", () => {
        const SERVER_LIMITS = {
          '1': 9,
          '2': 9,
          '3': 10,
          '4': 10,
          '5': 14,
          '6': 40
        };
        const hudText = (): string => normalized('.hud');

        it("shows the server's seconds on the intro of each stage, not the table's", () => {
          shared.load.and.returnValue(of(sharedQuiz({
            stageLock: 'open',
            timeLimits: SERVER_LIMITS
          })));
          openShared(lan);

          click('.stage-card', 'Màn 1');
          expect(text()).toContain('9 giây mỗi câu');
          expect(text()).not.toContain('12 giây');
          click('button', 'Về bản đồ');

          click('.stage-card', 'Màn 3');
          expect(text()).toContain('10 giây mỗi câu');
          click('button', 'Về bản đồ');

          click('.stage-card', 'Màn 6');
          expect(text()).toContain('40 giây mỗi câu');
        });

        it("counts the question down from the seconds the server dealt it with, which are the server's", () => {
          serve({ timeLimits: SERVER_LIMITS });
          openShared(lan);

          click('.stage-card', 'Màn 1');
          click('button', 'Bắt đầu');

          expect(hudText()).toContain('⏱ 9s');
        });

        it("says there is no limit when the server sends none for the stage, whatever the table says", () => {
          shared.load.and.returnValue(of(sharedQuiz({
            timeLimits: {
              ...SERVER_LIMITS,
              '1': null
            }
          })));
          openShared(lan);

          click('.stage-card', 'Màn 1');

          expect(text()).toContain('không giới hạn thời gian');
          expect(text()).not.toContain('giây mỗi câu');
        });

        it('takes them again from the check before a stage', () => {
          shared.load.and.returnValue(of(sharedQuiz({ timeLimits: SERVER_LIMITS })));
          openShared(lan);
          shared.load.and.returnValue(of(sharedQuiz({
            timeLimits: {
              ...SERVER_LIMITS,
              '1': 7
            }
          })));

          click('.stage-card', 'Màn 1');

          expect(text()).toContain('7 giây mỗi câu');
        });

        it("falls back to the stage's own seconds in the teacher's mode for a stage the server sent no limit for", () => {
          shared.load.and.returnValue(of(sharedQuiz({
            timeMode: 'extra',
            timeLimits: {}
          })));
          openShared(lan);

          click('.stage-card', 'Màn 1');

          expect(text()).toContain('18 giây mỗi câu');
        });

        it("does not carry them to a quiz played from a file, which uses the table's seconds", () => {
          shared.load.and.returnValue(of(sharedQuiz({ timeLimits: SERVER_LIMITS })));
          openShared(lan);

          params.next(convertToParamMap({}));
          fixture.detectChanges();
          click('button', 'Chơi thử quiz mẫu');
          click('.stage-card', 'Màn 1');

          expect(text()).toContain('12 giây mỗi câu');
        });
      });
    });

    describe('the avatar and the leaderboard', () => {
      const BOARD = studentBoard({
        top: [
          {
            rank: 1,
            name: 'Minh',
            avatar: 'dragon',
            stagesPassed: 3,
            correct: 14
          },
          {
            rank: 2,
            name: 'Lan',
            avatar: 'cat',
            stagesPassed: 2,
            correct: 9,
            you: true
          },
        ],
        you: {
          rank: 2,
          name: 'Lan',
          avatar: 'cat',
          stagesPassed: 2,
          correct: 9
        },
        playerCount: 2,
      });

      // The dialog is a modal: its content is in the overlay at the end of <body>, and appears a tick later.
      const dialog = (): HTMLElement | null => document.body.querySelector('.ant-modal-content');
      const radio = (label: string): HTMLButtonElement =>
        dialog()!.querySelector<HTMLButtonElement>(`button[role="radio"][aria-label="${label}"]`)!;
      const dialogOpen = (): boolean =>
        fixture.debugElement.query(By.directive(NzModalComponent)).componentInstance.nzVisible;
      const boardRows = (): string[] =>
        Array.from(element().querySelectorAll('app-student-leaderboard li.step'))
          .map(row => (row.querySelector('app-marquee-text')?.textContent ?? '').trim());

      async function pause(): Promise<void> {
        fixture.detectChanges();
        await new Promise(resolve => setTimeout(resolve, 30));
        fixture.detectChanges();
      }

      async function openDialog(): Promise<void> {
        click('.avatar-button');
        await pause();
      }

      async function save(): Promise<void> {
        document.body.querySelector<HTMLButtonElement>('.ant-modal-footer .ant-btn-primary')!.click();
        await pause();
      }

      beforeEach(() => {
        shared.leaderboard.and.callFake(() => of(BOARD));
      });

      describe('on the join screen', () => {
        it('joins with the avatar that was picked, and the map shows it', () => {
          openShared();

          joinAs('Lan', 'dragon');

          expect(shared.join).toHaveBeenCalledOnceWith(CODE, 'Lan', 'dragon');
          expect(avatarButton()!.textContent).toContain('🐲');
        });

        it('has the picker and the big avatar for the student to choose with', () => {
          openShared();

          expect(element().querySelector('app-share-join app-avatar-picker')).not.toBeNull();
          expect(element().querySelector('app-share-join .hero app-player-avatar')).not.toBeNull();
        });
      });

      describe('the map\'s line', () => {
        it('shows the avatar as a button to change it, then the name, "Không phải bạn?" and the closing time', () => {
          shared.load.and.returnValue(of(sharedQuiz({ closesAt: new Date(2026, 9, 14, 21, 30).toISOString() })));
          openShared(lan);

          const button = avatarButton()!;
          expect(button.type).toBe('button');
          expect(button.getAttribute('aria-label')).toBe('Đổi hình đại diện');
          expect(button.getAttribute('title')).toBe('Đổi hình đại diện');
          expect(button.querySelector('app-player-avatar')?.textContent?.trim()).toBe('🐱');
          expect(button.textContent).toContain('✎');
          expect(element().querySelector('.share-line app-marquee-text')?.textContent?.trim()).toBe('Lan');
          expect(shareLine()).toContain('Lan · Không phải bạn? · Bài đóng lúc 21:30 14/10');
        });

        it('draws a letter for a student who joined without an avatar', () => {
          openShared({
            ...lan,
            avatar: ''
          });

          expect(avatarButton()!.querySelector('app-player-avatar')?.textContent?.trim()).toBe('L');
        });

        it('carries a long name in full in its tooltip, to scroll', () => {
          const long = 'Nguyễn Hoàng Bảo Ngọc Lan Phương Thảo Vy';
          openShared({
            ...lan,
            name: long
          });

          expect(element().querySelector('.share-line app-marquee-text')?.getAttribute('title')).toBe(long);
        });
      });

      describe('the leaderboard', () => {
        it('is read for the quiz\'s code and shown below the map', () => {
          openShared(lan);

          expect(shared.leaderboard).toHaveBeenCalledWith(CODE);
          const board = element().querySelector('app-student-leaderboard')!;
          const map = element().querySelector('app-gesture-stage-map')!;
          expect(board.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
          expect(boardRows()).toEqual(['Minh', 'Lan']);
          expect(board.querySelector('.cheer')?.textContent).toContain('Chúc mừng');
        });

        it('is not on the join screen', () => {
          openShared();

          expect(element().querySelector('app-student-leaderboard')).toBeNull();
          expect(shared.leaderboard).not.toHaveBeenCalled();
        });

        it('is read again when the student is back on the map after a finished run', () => {
          openShared(lan);
          playStageOne(rightChoice);
          shared.leaderboard.calls.reset();

          click('button', 'Về bản đồ');

          expect(shared.leaderboard).toHaveBeenCalledOnceWith(CODE);
        });
      });

      describe('when the teacher hid the board', () => {
        beforeEach(() => {
          shared.load.and.returnValue(of(sharedQuiz({ showBoard: false })));
        });

        it('is not mounted on the map, and the board is never read', () => {
          openShared(lan);

          expect(stageCards().length).toBe(6);
          expect(element().querySelector('app-student-leaderboard')).toBeNull();
          expect(shared.leaderboard).not.toHaveBeenCalled();
        });

        it('is still not read after a result is saved and the student is back on the map', () => {
          openShared(lan);

          playStageOne(rightChoice);
          click('button', 'Về bản đồ');

          expect(shared.answer).toHaveBeenCalled();
          expect(element().querySelector('app-student-leaderboard')).toBeNull();
          expect(shared.leaderboard).not.toHaveBeenCalled();
        });
      });

      describe('changing the avatar', () => {
        it('opens a dialog with the picker on the current avatar, "Lưu" and "Hủy"', async () => {
          openShared(lan);

          await openDialog();

          expect(dialogOpen()).toBeTrue();
          expect(dialog()!.textContent).toContain('Đổi hình đại diện');
          expect(dialog()!.textContent).toContain('Hủy');
          expect(document.body.querySelector('.ant-modal-footer .ant-btn-primary')?.textContent?.trim()).toBe('Lưu');
          expect(radio('Mèo').getAttribute('aria-checked')).toBe('true');
          expect(dialog()!.querySelectorAll('button[aria-checked="true"]').length).toBe(1);
        });

        it('sends the new avatar, updates the line and the board, and closes', async () => {
          openShared(lan);
          shared.leaderboard.calls.reset();
          await openDialog();

          radio('Rồng').click();
          await save();

          expect(shared.setAvatar).toHaveBeenCalledOnceWith(CODE, 'dragon');
          expect(avatarButton()!.querySelector('app-player-avatar')?.textContent?.trim()).toBe('🐲');
          expect(dialogOpen()).toBeFalse();
          expect(shared.leaderboard).toHaveBeenCalledOnceWith(CODE);
          expect(notifications.error).not.toHaveBeenCalled();
        });

        it('only closes when the avatar was not changed', async () => {
          openShared(lan);
          await openDialog();

          await save();

          expect(shared.setAvatar).not.toHaveBeenCalled();
          expect(dialogOpen()).toBeFalse();
        });

        it('closes without sending when "Hủy" is pressed, and starts again from the avatar next time', async () => {
          openShared(lan);
          await openDialog();
          radio('Rồng').click();
          fixture.detectChanges();

          const cancel = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.ant-modal-footer button'))
            .find(candidate => candidate.textContent?.trim() === 'Hủy')!;
          cancel.click();
          await pause();

          expect(shared.setAvatar).not.toHaveBeenCalled();
          expect(dialogOpen()).toBeFalse();
          expect(avatarButton()!.querySelector('app-player-avatar')?.textContent?.trim()).toBe('🐱');
          await openDialog();
          expect(radio('Mèo').getAttribute('aria-checked')).toBe('true');
        });

        it('offers a random avatar to a student who has none, and sends it on "Lưu"', async () => {
          spyOn(Math, 'random').and.returnValue(0);
          openShared({
            ...lan,
            avatar: ''
          });

          await openDialog();
          expect(radio('Chuột').getAttribute('aria-checked')).toBe('true');
          await save();

          expect(shared.setAvatar).toHaveBeenCalledOnceWith(CODE, 'rat');
          expect(avatarButton()!.querySelector('app-player-avatar')?.textContent?.trim()).toBe('🐭');
        });

        it('shows it is saving and cannot be saved twice while the answer is awaited', async () => {
          openShared(lan);
          const answer = new Subject<PlayerIdentity>();
          shared.setAvatar.and.returnValue(answer);
          await openDialog();
          radio('Rồng').click();

          await save();
          await save();

          expect(shared.setAvatar).toHaveBeenCalledTimes(1);
          expect(document.body.querySelector('.ant-modal-footer .ant-btn-primary')?.classList).toContain('ant-btn-loading');
          expect(dialogOpen()).toBeTrue();

          answer.next({
            ...lan,
            avatar: 'dragon'
          });
          await pause();
          expect(dialogOpen()).toBeFalse();
          expect(avatarButton()!.querySelector('app-player-avatar')?.textContent?.trim()).toBe('🐲');
        });

        it('sends a student the teacher removed to the join screen on a 403', async () => {
          openShared(lan);
          shared.setAvatar.and.callFake(() => {
            // The service forgets the student on a 403 before it rethrows.
            stored = null;
            return httpError(403, 'Unknown player');
          });
          await openDialog();
          radio('Rồng').click();

          await save();

          expect(dialogOpen()).toBeFalse();
          expect(element().querySelector('app-share-join')).not.toBeNull();
          expect(stageCards().length).toBe(0);
          expect(notifications.error).not.toHaveBeenCalled();
        });

        it('shows the closed card, and the final board, on a 410', async () => {
          openShared(lan);
          shared.setAvatar.and.returnValue(httpError(410, 'Assignment closed'));
          await openDialog();
          radio('Rồng').click();
          shared.leaderboard.calls.reset();

          await save();

          expect(dialogOpen()).toBeFalse();
          expect(text()).toContain('Bài này đã đóng. Cảm ơn bạn đã tham gia!');
          expect(stageCards().length).toBe(0);
          expect(element().querySelector('main a')).toBeNull();
          expect(shared.leaderboard).toHaveBeenCalledWith(CODE);
          expect(boardRows()).toEqual(['Minh', 'Lan']);
        });

        it('keeps the dialog and says so on any other failure, leaving the avatar as it was', async () => {
          openShared(lan);
          shared.setAvatar.and.returnValue(httpError(500));
          await openDialog();
          radio('Rồng').click();

          await save();

          expect(notifications.error).toHaveBeenCalledOnceWith('Chưa đổi được hình', '', jasmine.anything());
          expect(dialogOpen()).toBeTrue();
          expect(avatarButton()!.querySelector('app-player-avatar')?.textContent?.trim()).toBe('🐱');
          expect(stageCards().length).toBe(6);
          expect(document.body.querySelector('.ant-modal-footer .ant-btn-primary')?.classList).not.toContain('ant-btn-loading');
        });

        it('says so too when the server cannot be reached, and works on a retry', async () => {
          openShared(lan);
          shared.setAvatar.and.returnValue(httpError(0));
          await openDialog();
          radio('Rồng').click();
          await save();
          expect(notifications.error).toHaveBeenCalledTimes(1);

          shared.setAvatar.and.callFake((_code: string, avatar: string) => of({
            ...lan,
            avatar
          }));
          await save();

          expect(shared.setAvatar).toHaveBeenCalledTimes(2);
          expect(dialogOpen()).toBeFalse();
          expect(avatarButton()!.querySelector('app-player-avatar')?.textContent?.trim()).toBe('🐲');
        });
      });

      describe('the closed card', () => {
        it('shows the final board under the message when the quiz is closed and this device joined', () => {
          shared.load.and.returnValue(httpError(410, 'Assignment closed'));
          openShared(lan);

          expect(text()).toContain('Bài này đã đóng. Cảm ơn bạn đã tham gia!');
          expect(shared.leaderboard).toHaveBeenCalledWith(CODE);
          expect(boardRows()).toEqual(['Minh', 'Lan']);
          expect(element().querySelector('.closed-board')).not.toBeNull();
          expect(element().querySelector('main a')).toBeNull();
        });

        it('shows it when the quiz closes before a stage too', () => {
          openShared(lan);
          shared.load.and.returnValue(httpError(410, 'Assignment closed'));
          shared.leaderboard.calls.reset();

          click('.stage-card', 'Màn 1');

          expect(text()).toContain('Bài này đã đóng.');
          expect(shared.leaderboard).toHaveBeenCalledWith(CODE);
          expect(boardRows()).toEqual(['Minh', 'Lan']);
        });

        it('has no board on the card reached from the check before a stage when the teacher hid it', () => {
          shared.load.and.returnValue(of(sharedQuiz({ showBoard: false })));
          openShared(lan);
          shared.load.and.returnValue(httpError(410, 'Assignment closed'));

          click('.stage-card', 'Màn 1');

          expect(text()).toContain('Bài này đã đóng.');
          expect(element().querySelector('app-student-leaderboard')).toBeNull();
          expect(shared.leaderboard).not.toHaveBeenCalled();
        });

        it('draws nothing when the link was already closed when opened and the server says the board is hidden', () => {
          shared.load.and.returnValue(httpError(410, 'Assignment closed'));
          shared.leaderboard.and.returnValue(httpError(404, 'Board hidden'));
          openShared(lan);

          expect(text()).toContain('Bài này đã đóng.');
          expect(shared.leaderboard).toHaveBeenCalledOnceWith(CODE);
          expect(boardRows()).toEqual([]);
          expect(element().querySelector('app-student-leaderboard section')).toBeNull();
        });

        it('has no board for a device that never joined', () => {
          shared.load.and.returnValue(httpError(410, 'Assignment closed'));
          openShared();

          expect(text()).toContain('Bài này đã đóng.');
          expect(element().querySelector('app-student-leaderboard')).toBeNull();
          expect(shared.leaderboard).not.toHaveBeenCalled();
        });

        it('has no board when the closed quiz is the answer to a join', () => {
          openShared();
          shared.join.and.returnValue(httpError(410, 'Assignment closed'));

          joinAs('Lan');

          expect(text()).toContain('Bài này đã đóng.');
          expect(element().querySelector('app-student-leaderboard')).toBeNull();
        });

        it('has no board on the other error cards', () => {
          shared.load.and.returnValue(httpError(404, 'Assignment not found'));
          openShared(lan);

          expect(text()).toContain('Không tìm thấy bài này.');
          expect(element().querySelector('app-student-leaderboard')).toBeNull();
          expect(shared.leaderboard).not.toHaveBeenCalled();
        });
      });
    });

    describe('the pass percentage', () => {
      // Plays stage 1 answering the first `right` questions right and the rest wrong.
      function playStageOneRight(right: number): void {
        let asked = 0;
        playStageOne(() => (asked++ < right ? rightChoice() : anyWrongChoice()));
      }

      it('says on the intro what the percentage of the teacher comes to', () => {
        shared.load.and.returnValue(of(sharedQuiz({
          passPercents: {
            1: 50,
            2: 70,
            3: 70,
            4: 70,
            5: 70,
            6: 70
          }
        })));
        openShared(lan);

        click('.stage-card', 'Màn 1');

        expect(text()).toContain('Đúng ít nhất 3/5');
      });

      it('passes 3 of 5 at 50%, where the default would fail it', () => {
        serve({
          passPercents: {
            1: 50,
            2: 70,
            3: 70,
            4: 70,
            5: 70,
            6: 70
          }
        });
        openShared(lan);

        playStageOneRight(3);

        expect(text()).toContain('Qua màn 1!');
        expect(text()).toContain('Đúng ít nhất 3/5');
        expect(normalized('.score')).toContain('Đúng 3/5 câu');
        expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!)[SAVED_KEY].passed).toEqual([1]);
        expect(text()).toContain('Màn tiếp theo');
      });

      it('fails 3 of 5 at the default 70%', () => {
        openShared(lan);

        playStageOneRight(3);

        expect(text()).toContain('Chưa qua màn 1');
        expect(text()).toContain('Đúng ít nhất 4/5');
      });

      it('asks for every answer at 100%', () => {
        serve({
          passPercents: {
            1: 100,
            2: 70,
            3: 70,
            4: 70,
            5: 70,
            6: 70
          }
        });
        openShared(lan);

        playStageOneRight(4);

        expect(text()).toContain('Chưa qua màn 1');
        expect(text()).toContain('Đúng ít nhất 5/5');
      });

      it('shows the own percentage of each stage on the map when they differ', () => {
        shared.load.and.returnValue(of(sharedQuiz({
          passPercents: {
            1: 50,
            2: 70,
            3: 70,
            4: 70,
            5: 70,
            6: 70
          }
        })));
        openShared(lan);

        const cards = stageCards();
        expect(cards[0].textContent).toContain('qua màn từ 50%');
        expect(cards[1].textContent).not.toContain('qua màn từ');
        expect(normalized('.summary')).toContain('Điểm qua màn ghi trên thẻ từng màn');
      });

      it('names the one percentage in the summary of the map when every stage shares it', () => {
        shared.load.and.returnValue(of(sharedQuiz({
          passPercents: {
            1: 50,
            2: 50,
            3: 50,
            4: 50,
            5: 50,
            6: 50
          }
        })));
        openShared(lan);

        expect(normalized('.summary')).toContain('Đúng từ 50% số câu để mở màn sau.');
      });
    });

    describe('the stage lock', () => {
      it('keeps the later stages locked until the earlier one is passed by default', () => {
        openShared(lan);

        const cards = Array.from(element().querySelectorAll<HTMLButtonElement>('.stage-card'));
        expect(cards[0].disabled).toBeFalse();
        expect(cards.slice(1).every(card => card.disabled)).toBeTrue();
      });

      it('opens every stage from the start when the teacher chose the open lock', () => {
        shared.load.and.returnValue(of(sharedQuiz({ stageLock: 'open' })));
        openShared(lan);

        const cards = Array.from(element().querySelectorAll<HTMLButtonElement>('.stage-card'));
        expect(cards.length).toBe(6);
        expect(cards.every(card => !card.disabled)).toBeTrue();

        click('.stage-card', 'Màn 3');
        expect(text()).toContain('Ếch đớp chữ');
      });
    });

    describe('the replay limit', () => {
      const limited = (overrides: Partial<SharedQuiz> = {}) =>
        sharedQuiz({
          stageLock: 'open',
          maxAttempts: 2, ...overrides
        });
      const cardText = (index: number): string => (stageCards()[index].textContent ?? '').replace(/\s+/g, ' ');

      // Answers the five questions of the stage on screen.
      function answerQuestions(answer: () => number | string[]): void {
        for (let question = 0; question < 5; question += 1) {
          game().choose.emit(answer());
          fixture.detectChanges();
          click('button', 'Tiếp');
        }
      }

      function replay(answer: () => number | string[]): void {
        click('button', 'Chơi lại màn');
        answerQuestions(answer);
      }

      it('says nothing about runs on the map when there is no limit', () => {
        serve({ stageLock: 'open' });
        openShared(lan);

        expect(stageCards().some(card => /lượt/.test(card.textContent ?? ''))).toBeFalse();
        expect(stageCards().every(card => !card.disabled)).toBeTrue();
      });

      it('says how many runs each stage has left', () => {
        serve(limited({ attempts: { 1: 1 } }));
        openShared(lan);

        expect(cardText(0)).toContain('Còn 1 lượt');
        expect(cardText(1)).toContain('Còn 2 lượt');
        expect(stageCards().every(card => !card.disabled)).toBeTrue();
      });

      it('shows a stage with all its runs used as used up, and it cannot be opened', () => {
        serve(limited({
          attempts: {
            1: 2,
            3: 5
          }
        }));
        openShared(lan);

        expect(cardText(0)).toContain('Hết lượt');
        expect(stageCards()[0].disabled).toBeTrue();
        expect(stageCards()[2].disabled).toBeTrue();
        expect(stageCards()[1].disabled).toBeFalse();
        shared.load.calls.reset();
        stageCards()[0].click();
        fixture.detectChanges();
        expect(shared.load).not.toHaveBeenCalled();
        expect(element().querySelector('.intro')).toBeNull();
      });

      it('lets a run be replayed while runs are left', () => {
        serve(limited());
        openShared(lan);

        playStageOne(wrongChoice);
        expect(element().querySelector('app-gesture-stage-result')?.textContent).toContain('Chơi lại màn');
        expect(text()).not.toContain('Bạn đã dùng hết lượt chơi màn này');

        replay(wrongChoice);

        expect(shared.startRun).toHaveBeenCalledTimes(2);
        expect(text()).toContain('Chưa qua màn 1');
      });

      it('hides the replay and says why when the last run is used', () => {
        serve(limited());
        openShared(lan);
        playStageOne(wrongChoice);

        replay(wrongChoice);

        expect(text()).not.toContain('Chơi lại màn');
        expect(text()).toContain('Bạn đã dùng hết lượt chơi màn này');
        expect(text()).toContain('Về bản đồ');
        click('button', 'Về bản đồ');
        expect(cardText(0)).toContain('Hết lượt');
        expect(stageCards()[0].disabled).toBeTrue();
      });

      it('still offers the next stage at the limit', () => {
        serve(limited({ maxAttempts: 1 }));
        openShared(lan);

        playStageOne(rightChoice);

        expect(text()).not.toContain('Chơi lại màn');
        expect(text()).toContain('Màn tiếp theo');
        click('button', 'Màn tiếp theo');
        expect(text()).toContain('Nghiêng đầu');
      });

      it('counts a run from the moment it starts, finished or not', () => {
        serve(limited());
        openShared(lan);
        click('.stage-card', 'Màn 1');
        click('button', 'Bắt đầu');
        expect(shared.answer).not.toHaveBeenCalled();

        click('button[aria-label="Về bản đồ"]');

        expect(cardText(0)).toContain('Còn 1 lượt');
      });

      it("takes the number of runs from the server's answer to the start", () => {
        serve(limited({ maxAttempts: 5 }));
        openShared(lan);
        // Another device used three runs of the stage since this page was opened.
        server.started['1'] = 3;

        click('.stage-card', 'Màn 1');
        click('button', 'Bắt đầu');
        click('button[aria-label="Về bản đồ"]');

        expect(cardText(0)).toContain('Còn 1 lượt');
      });

      it('goes back to the map, with the stage used up, when the check finds the runs gone elsewhere', () => {
        serve(limited());
        openShared(lan);
        server.started['1'] = 2;

        click('.stage-card', 'Màn 1');

        expect(element().querySelector('.intro')).toBeNull();
        expect(stageCards().length).toBe(6);
        expect(cardText(0)).toContain('Hết lượt');
        expect(stageCards()[0].disabled).toBeTrue();
      });

      it('checks again before a replay, and does not start a stage the server has used up', () => {
        serve(limited({ maxAttempts: 3 }));
        openShared(lan);
        playStageOne(wrongChoice);
        server.started['1'] = 3;
        shared.startRun.calls.reset();

        click('button', 'Chơi lại màn');

        expect(shared.startRun).not.toHaveBeenCalled();
        expect(element().querySelector('.stage[data-game]')).toBeNull();
        expect(cardText(0)).toContain('Hết lượt');
      });

      it('marks the stage used up and says so when the server refuses to start the run', () => {
        serve(limited({ maxAttempts: 5 }));
        openShared(lan);
        shared.startRun.and.returnValue(httpError(409, 'Replay limit reached'));

        click('.stage-card', 'Màn 1');
        click('button', 'Bắt đầu');

        expect(shared.startRun).toHaveBeenCalledTimes(1);
        expect(notifications.warning).toHaveBeenCalledOnceWith('Hết lượt chơi', '', jasmine.anything());
        expect(element().querySelector('.stage[data-game]')).toBeNull();
        expect(cardText(0)).toContain('Hết lượt');
        expect(stageCards()[0].disabled).toBeTrue();
      });

      it('gives a new student on the device all the runs', () => {
        serve(limited({ attempts: { 1: 2 } }));
        openShared(lan);
        expect(stageCards()[0].disabled).toBeTrue();

        click('a', 'Không phải bạn?');
        joinAs('Nam');

        expect(cardText(0)).toContain('Còn 2 lượt');
        expect(stageCards()[0].disabled).toBeFalse();
      });
    });

    describe('progress', () => {
      it('keeps each student\'s progress under a key of the assignment and the student', () => {
        openShared(lan);
        playStageOne(rightChoice);

        const store = JSON.parse(localStorage.getItem(PROGRESS_KEY)!);
        expect(store[SAVED_KEY].passed).toEqual([1]);
        // Not under the quiz's own key, which a file or a job of the same questions uses.
        expect(store[demoQuiz.key]).toBeUndefined();

        click('button', 'Về bản đồ');
        expect(stageCards().map(card => card.disabled)).toEqual([false, false, true, true, true, true]);
      });

      it('starts another student on the same device from the beginning', () => {
        openShared(lan);
        playStageOne(rightChoice);
        click('button', 'Về bản đồ');

        click('a', 'Không phải bạn?');
        joinAs('Nam');

        expect(stageCards().map(card => card.disabled)).toEqual([false, true, true, true, true, true]);
        // Lan's pass is still there, under Lan's key.
        expect(Object.keys(JSON.parse(localStorage.getItem(PROGRESS_KEY)!))).toEqual([SAVED_KEY]);
      });
    });

    describe('before a stage', () => {
      it('asks the server again and opens the intro', () => {
        openShared(lan);
        shared.load.calls.reset();

        click('.stage-card', 'Màn 1');

        expect(shared.load).toHaveBeenCalledOnceWith(CODE);
        expect(text()).toContain('Đúng ít nhất 4/5');
      });

      it('shows a spinner while it asks, and opens the intro when the answer comes', () => {
        openShared(lan);
        const answer = new Subject<SharedQuiz>();
        shared.load.and.returnValue(answer);

        click('.stage-card', 'Màn 1');
        expect(text()).toContain('Đang kiểm tra bài…');
        expect(element().querySelector('nz-spin')).not.toBeNull();

        answer.next(sharedQuiz());
        fixture.detectChanges();
        expect(text()).toContain('Đúng ít nhất 4/5');
      });

      it('shows the closed card when the quiz closed in the meantime', () => {
        openShared(lan);
        shared.load.and.returnValue(httpError(410, 'Assignment closed'));

        click('.stage-card', 'Màn 1');

        expect(text()).toContain('Bài này đã đóng. Cảm ơn bạn đã tham gia!');
        expect(element().querySelector('main a')).toBeNull();
        expect(stageCards().length).toBe(0);
        expect(element().querySelector('.intro')).toBeNull();
      });

      it('shows the not-found card when the assignment was deleted in the meantime', () => {
        openShared(lan);
        shared.load.and.returnValue(httpError(404, 'Assignment not found'));

        click('.stage-card', 'Màn 1');

        expect(text()).toContain('Không tìm thấy bài này.');
      });

      it('still opens the stage when the server cannot be reached, where starting the run reports its own failure', () => {
        openShared(lan);
        shared.load.and.returnValue(httpError(0));

        click('.stage-card', 'Màn 1');

        expect(text()).toContain('Đúng ít nhất 4/5');
        expect(element().querySelector('.back-link')).toBeNull();
      });

      it('checks again before a replay', () => {
        openShared(lan);
        playStageOne(wrongChoice);
        shared.load.calls.reset();
        shared.load.and.returnValue(httpError(410, 'Assignment closed'));

        click('button', 'Chơi lại màn');

        expect(shared.load).toHaveBeenCalledOnceWith(CODE);
        expect(text()).toContain('Bài này đã đóng.');
      });

      it('sends a student the teacher removed back to the join screen', () => {
        openShared(lan);
        // The server forgot the student: the service dropped the identity after a 403.
        stored = null;

        click('.stage-card', 'Màn 1');

        expect(element().querySelector('app-share-join')).not.toBeNull();
        expect(element().querySelector('.intro')).toBeNull();
      });
    });

    // The server runs the stage: the page asks it to start a run, is dealt one question at a time without its
    // answer, sends each choice and shows the verdict that comes back. The fake server above plays that part;
    // a spec that needs it to be slow or to fail swaps the spied method for a Subject or an error.
    describe('a run on the server', () => {
      // The page's own animation loop does not run inside a synchronous spec, so its frames are driven by hand
      // on a clock of the spec's own, which `performance.now` reads too (the page takes the time a question was
      // dealt from it).
      let clock: number;
      const page = (): { frame(now: number): void } => fixture.componentInstance as unknown as {
        frame(now: number): void
      };

      function tickFrames(ms: number, step = 100): void {
        for (let elapsed = 0; elapsed < ms; elapsed += step) {
          clock += step;
          page().frame(clock);
        }
        fixture.detectChanges();
      }

      beforeEach(() => {
        clock = 5000;
        spyOn(performance, 'now').and.callFake(() => clock);
      });

      // The explanation the sample gives for the question on screen.
      function explanationOnScreen(): string {
        const view = game().question();
        return demoQuiz.stages.get(view.stage)!.find(candidate => candidate.question === view.question)!.explanation;
      }

      function startStage(label = 'Màn 1'): void {
        click('.stage-card', label);
        click('button', 'Bắt đầu');
      }

      const hud = (): string => normalized('.hud');
      const pauseButton = (): HTMLButtonElement => element().querySelector<HTMLButtonElement>('.hud-buttons button')!;

      describe('starting', () => {
        it('asks the server to start the stage and plays the first question it deals', () => {
          openShared(lan);

          startStage();

          expect(shared.startRun).toHaveBeenCalledOnceWith(CODE, 1);
          expect(element().querySelector('app-true-false-game')).not.toBeNull();
          expect(game().question()).toEqual({
            stage: 1,
            question: demoQuiz.stages.get(1)![0].question,
            options: ['Đúng', 'Sai']
          });
          expect(hud()).toContain('Câu 1/5');
          expect(hud()).toContain('⏱ 12s');
          expect(audio.play).toHaveBeenCalledWith('start');
        });

        it('plays the run as the server dealt it: its total, its options and, for a sentence, its pieces', () => {
          serve({
            stageLock: 'open',
            stageCounts: {
              '2': 4,
              '6': 2
            }
          });
          shared.startRun.and.callFake((_code: string, stage: number) => {
            const question: SharedQuestion = stage === 6
              ? {
                index: 0,
                question: 'Tôi uống trà.',
                options: [],
                chunks: ['茶', '我', '喝'],
                timeLeftMs: 68000,
                graceMs: 5000
              }
              : {
                index: 0,
                question: 'Con mèo trong tiếng Trung là gì?',
                options: ['狗', '猫'],
                chunks: null,
                timeLeftMs: 23000,
                graceMs: 5000
              };
            return of({
              runId: 'r',
              stage,
              total: stage === 6 ? 2 : 4,
              attempts: 1,
              question
            });
          });
          openShared(lan);

          startStage('Màn 1');
          expect(game().question()).toEqual({
            stage: 2,
            question: 'Con mèo trong tiếng Trung là gì?',
            options: ['狗', '猫']
          });
          expect(hud()).toContain('Câu 1/4');
          click('button[aria-label="Về bản đồ"]');

          startStage('Màn 2');
          expect(element().querySelector('app-word-order-game')).not.toBeNull();
          expect(game().question()).toEqual({
            stage: 6,
            question: 'Tôi uống trà.',
            options: [],
            chunks: ['茶', '我', '喝']
          });
          expect(hud()).toContain('Câu 1/2');
          expect(hud()).toContain('⏱ 68s');
        });

        it('shows the button as loading while the run starts, and the stage when it has', () => {
          const start = new Subject<SharedRunStart>();
          shared.startRun.and.returnValue(start);
          openShared(lan);
          click('.stage-card', 'Màn 1');

          click('button', 'Bắt đầu');
          click('button', 'Bắt đầu');

          expect(shared.startRun).toHaveBeenCalledTimes(1);
          expect(element().querySelector('.intro')).not.toBeNull();
          const button = Array.from(element().querySelectorAll('button')).find(b => b.textContent?.includes('Bắt đầu'))!;
          expect(button.classList).toContain('ant-btn-loading');
          expect(element().querySelector('.stage[data-game]')).toBeNull();

          start.next(runStart(1));
          fixture.detectChanges();
          expect(element().querySelector('app-true-false-game')).not.toBeNull();
        });

        it('starts a replay from the result screen after the check, with a spinner for the start', () => {
          openShared(lan);
          playStageOne(wrongChoice);
          const start = new Subject<SharedRunStart>();
          shared.startRun.and.returnValue(start);

          click('button', 'Chơi lại màn');

          expect(shared.startRun).toHaveBeenCalledTimes(2);
          expect(text()).toContain('Đang bắt đầu màn…');
          expect(element().querySelector('nz-spin')).not.toBeNull();
        });

        it('asks the server again for every replay, which is a new run', () => {
          openShared(lan);
          playStageOne(wrongChoice);

          click('button', 'Chơi lại màn');

          expect(shared.startRun.calls.allArgs()).toEqual([[CODE, 1], [CODE, 1]]);
          expect(hud()).toContain('Câu 1/5');
          expect(hud()).toContain('⭐ 0');
        });
      });

      describe('answering', () => {
        it('sends the choice with the run and the number of the question, and shows what the server says', () => {
          openShared(lan);
          startStage();

          const choice = rightChoice();
          game().choose.emit(choice);
          fixture.detectChanges();

          expect(shared.answer).toHaveBeenCalledOnceWith(CODE, 'run-1', 0, choice as number);
          expect(text()).toContain('Chính xác! +10');
          expect(text()).toContain('⭐ 10');
          expect(game().reveal()).toEqual({
            chosen: choice,
            correct: true,
            correctIndex: choice as number,
            correctOrder: undefined
          });
          expect(audio.play).toHaveBeenCalledWith('correct', 1);
        });

        it('shows the right answer and the explanation only once the verdict is in', () => {
          const verdict = new Subject<SharedVerdict>();
          openShared(lan);
          startStage();
          const explanation = explanationOnScreen();
          expect(explanation).not.toBe('');
          expect(text()).not.toContain(explanation);
          expect(text()).not.toContain('Đáp án:');
          shared.answer.and.returnValue(verdict);

          game().choose.emit(rightChoice());
          fixture.detectChanges();

          expect(text()).toContain('Đang chờ kết quả…');
          expect(text()).not.toContain(explanation);
          expect(text()).not.toContain('Đáp án:');
          expect(game().reveal()).toBeNull();
          expect(audio.play).not.toHaveBeenCalledWith('correct', jasmine.anything());

          verdict.next(judgeOnServer(0, rightChoice()));
          fixture.detectChanges();

          expect(text()).toContain(explanation);
          expect(text()).toContain('Đáp án:');
          expect(text()).not.toContain('Đang chờ kết quả…');
          expect(game().reveal()).not.toBeNull();
        });

        it('ignores a second choice, and a time-up, while the answer is out', () => {
          const verdict = new Subject<SharedVerdict>();
          shared.answer.and.returnValue(verdict);
          openShared(lan);
          startStage();

          game().choose.emit(rightChoice());
          game().choose.emit(wrongChoice());
          tickFrames(20000);

          expect(shared.answer).toHaveBeenCalledTimes(1);
          expect(shared.answer.calls.mostRecent().args[3]).toBe(rightChoice());
        });

        it('stops the clock while the answer is out', () => {
          const verdict = new Subject<SharedVerdict>();
          shared.answer.and.returnValue(verdict);
          openShared(lan);
          startStage();
          tickFrames(3600);
          expect(hud()).toContain('⏱ 9s');

          game().choose.emit(rightChoice());
          tickFrames(8000);

          expect(hud()).toContain('⏱ 9s');
        });

        it('shows a wrong answer with the right one from the server, and scores nothing', () => {
          openShared(lan);
          startStage();

          game().choose.emit(wrongChoice());
          fixture.detectChanges();

          expect(shared.answer.calls.mostRecent().args[3]).toBe(wrongChoice());
          expect(text()).toContain('Chưa đúng');
          expect(text()).toContain('⭐ 0');
          expect(text()).toContain('Đáp án:');
          expect(text()).toContain(explanationOnScreen());
          expect(game().reveal()).toEqual(jasmine.objectContaining({
            correct: false,
            correctIndex: rightChoice() as number
          }));
          expect(audio.play).toHaveBeenCalledWith('wrong');
        });

        it('sends the pieces of a sentence in the order picked and shows the order the server says is right', () => {
          serve({ stageLock: 'open' });
          openShared(lan);
          startStage('Màn 6');

          const order = rightChoice() as string[];
          game().choose.emit(order);
          fixture.detectChanges();

          expect(shared.answer).toHaveBeenCalledOnceWith(CODE, 'run-1', 0, order);
          expect(game().reveal()).toEqual(jasmine.objectContaining({
            correct: true,
            correctOrder: order
          }));
          expect(normalized('.answer')).toBe(`Đáp án: ${order.join('')}`);
          expect(text()).toContain('Chính xác!');
        });

        it('shows a time-out from the page\'s own clock as one, and sends null', () => {
          openShared(lan);
          startStage();

          tickFrames(12500);

          expect(shared.answer).toHaveBeenCalledOnceWith(CODE, 'run-1', 0, null);
          expect(text()).toContain('Hết giờ');
          expect(game().reveal()).toEqual(jasmine.objectContaining({
            chosen: null,
            correct: false
          }));
          expect(audio.play).toHaveBeenCalledWith('timeout');
          expect(text()).toContain('Đáp án:');
          expect(text()).toContain(explanationOnScreen());
        });

        it('shows the verdict of a time-out as one even when the choice was sent along and the server was late', () => {
          shared.answer.and.callFake((_code: string, _runId: string, index: number, choice: number | string[] | null) =>
            of({
              ...judgeOnServer(index, choice),
              correct: false,
              timedOut: true
            }));
          openShared(lan);
          startStage();

          game().choose.emit(rightChoice());
          fixture.detectChanges();

          expect(text()).toContain('Hết giờ');
          expect(game().reveal()).toEqual(jasmine.objectContaining({
            chosen: null,
            correct: false
          }));
          expect(text()).toContain('⭐ 0');
          expect(audio.play).toHaveBeenCalledWith('timeout');
        });

        it('counts the streak and lists the missed questions from the verdicts', () => {
          openShared(lan);
          startStage();

          [rightChoice, rightChoice, anyWrongChoice, rightChoice, anyWrongChoice].forEach((answer, position) => {
            game().choose.emit(answer());
            fixture.detectChanges();
            if (position === 1) {
              expect(text()).toContain('🔥 Chuỗi đúng 2');
            }
            click('button', 'Tiếp');
          });

          expect(normalized('.score')).toContain('Đúng 3/5 câu');
          expect(element().querySelectorAll('.missed li').length).toBe(2);
          expect(element().querySelector('.missed li .missed-explanation')?.textContent?.trim()).not.toBe('');
        });
      });

      describe('the next question', () => {
        it('keeps the view and the verdict on screen until the question arrives, then swaps them in one step', () => {
          openShared(lan);
          startStage();
          const before = element().querySelector('app-true-false-game');
          game().choose.emit(rightChoice());
          fixture.detectChanges();
          const dealtNext = new Subject<SharedQuestion>();
          shared.nextQuestion.and.returnValue(dealtNext);

          click('button', 'Tiếp');

          expect(shared.nextQuestion).toHaveBeenCalledOnceWith(CODE, 'run-1');
          expect(hud()).toContain('Câu 1/5');
          expect(game().reveal()).not.toBeNull();
          expect(text()).toContain('Chính xác!');
          expect(Array.from(element().querySelectorAll('button')).find(b => b.textContent?.includes('Tiếp'))!.classList)
            .toContain('ant-btn-loading');

          dealtNext.next(dealt(server.run!, 1));
          fixture.detectChanges();

          expect(hud()).toContain('Câu 2/5');
          expect(game().reveal()).toBeNull();
          expect(game().question().question).toBe(demoQuiz.stages.get(1)![1].question);
          expect(element().querySelector('app-true-false-game')).toBe(before);
          expect(text()).not.toContain('Chính xác!');
          expect(text()).not.toContain('Đáp án:');
        });

        it('asks once however many times it is pressed, and not again from the loop while it is out', () => {
          openShared(lan);
          startStage();
          game().choose.emit(rightChoice());
          fixture.detectChanges();
          shared.nextQuestion.and.returnValue(new Subject<SharedQuestion>());

          click('button', 'Tiếp');
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
          tickFrames(6000);

          expect(shared.nextQuestion).toHaveBeenCalledTimes(1);
        });

        it('moves on by itself a moment after the verdict', () => {
          openShared(lan);
          startStage();
          game().choose.emit(rightChoice());
          fixture.detectChanges();

          tickFrames(2600);

          expect(shared.nextQuestion).toHaveBeenCalledTimes(1);
          expect(hud()).toContain('Câu 2/5');
        });

        it('times the question by what the server says is left, and waits for no limit when it says none', () => {
          openShared(lan);
          startStage();
          game().choose.emit(rightChoice());
          fixture.detectChanges();
          shared.nextQuestion.and.returnValue(of({
            ...dealt(server.run!, 1),
            timeLeftMs: 7300
          }));

          click('button', 'Tiếp');
          expect(hud()).toContain('⏱ 8s');
          game().choose.emit(rightChoice());
          fixture.detectChanges();
          shared.nextQuestion.and.returnValue(of({
            ...dealt(server.run!, 2),
            timeLeftMs: null
          }));

          click('button', 'Tiếp');
          expect(hud()).toContain('⏱ ∞');
          tickFrames(60000);
          expect(shared.answer).toHaveBeenCalledTimes(2);
        });
      });

      describe('finishing', () => {
        it('goes to the result after the last verdict without asking for another question', () => {
          openShared(lan);

          playStageOne(rightChoice);

          expect(shared.nextQuestion).toHaveBeenCalledTimes(4);
          expect(shared.answer).toHaveBeenCalledTimes(5);
          expect(text()).toContain('Qua màn 1!');
          expect(normalized('.score')).toContain('Đúng 5/5 câu');
          expect(normalized('.score')).toContain('50 điểm');
          expect(text()).toContain('Đã lưu kết quả cho thầy cô ✓');
          expect(audio.play).toHaveBeenCalledWith('finish');
        });

        it('shows a failed run with the missed questions and the explanations the server gave', () => {
          openShared(lan);

          playStageOne(wrongChoice);

          expect(text()).toContain('Chưa qua màn 1');
          expect(text()).toContain('Đã lưu kết quả cho thầy cô ✓');
          expect(element().querySelectorAll('.missed li').length).toBe(5);
          expect(normalized('.missed-explanation')).toContain('你好 là lời chào thông dụng nhất khi gặp nhau.');
        });

        it('shows the numbers the server worked out for the run, and writes them as the progress of the device', () => {
          shared.answer.and.callFake((_code: string, _runId: string, index: number, choice: number | string[] | null) => {
            const verdict = judgeOnServer(index, choice);
            return of(verdict.result ? {
              ...verdict,
              result: {
                correct: 3,
                total: 5,
                passed: false
              }
            } : verdict);
          });
          openShared(lan);

          playStageOne(rightChoice);

          expect(text()).toContain('Chưa qua màn 1');
          expect(normalized('.score')).toContain('Đúng 3/5 câu');
          expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!)[SAVED_KEY]).toEqual({
            passed: [],
            best: {
              1: {
                correct: 3,
                total: 5
              }
            }
          });
        });

        it('opens the next stage on the map from what the server recorded', () => {
          openShared(lan);

          playStageOne(rightChoice);
          click('button', 'Về bản đồ');

          expect(stageCards().map(card => card.disabled)).toEqual([false, false, true, true, true, true]);
          expect(stageCards()[0].textContent).toContain('Đã qua');
        });

        it('keeps nothing back on the device: a later visit gets the result from the server', () => {
          openShared(lan);
          playStageOne(rightChoice);
          fixture.destroy();
          localStorage.removeItem(PROGRESS_KEY);

          openShared(lan);

          expect(stageCards()[0].textContent).toContain('Đã qua');
          expect(stageCards().map(card => card.disabled)).toEqual([false, false, true, true, true, true]);
        });

        it('lets a stage that a run on another device passed unlock the next one at the check before it', () => {
          openShared(lan);
          expect(stageCards()[1].disabled).toBeTrue();
          server.results['1'] = {
            correct: 5,
            total: 5,
            passed: true
          };

          click('.stage-card', 'Màn 1');
          click('button', 'Về bản đồ');

          expect(stageCards()[1].disabled).toBeFalse();
        });
      });

      describe('pausing', () => {
        it('is not offered while a timed question is open: the button is off, P does nothing, a hidden tab does not pause', () => {
          openShared(lan);
          startStage();

          expect(pauseButton().disabled).toBeTrue();
          expect(pauseButton().getAttribute('title')).toBe('Không tạm dừng được khi thời gian đang chạy');
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
          fixture.detectChanges();
          expect(game().paused()).toBeFalse();
          expect(text()).not.toContain('Tạm dừng');

          spyOnProperty(document, 'hidden', 'get').and.returnValue(true);
          document.dispatchEvent(new Event('visibilitychange'));
          fixture.detectChanges();
          expect(game().paused()).toBeFalse();
        });

        it('is not offered while the answer is out either', () => {
          shared.answer.and.returnValue(new Subject<SharedVerdict>());
          openShared(lan);
          startStage();

          game().choose.emit(rightChoice());
          fixture.detectChanges();

          expect(pauseButton().disabled).toBeTrue();
        });

        it('is offered during the verdict, when nothing is running, and is off again on the next question', () => {
          openShared(lan);
          startStage();
          game().choose.emit(rightChoice());
          fixture.detectChanges();

          expect(pauseButton().disabled).toBeFalse();
          pauseButton().click();
          fixture.detectChanges();
          expect(game().paused()).toBeTrue();
          expect(text()).toContain('Tạm dừng');

          // The next question arrives while the page is paused: its clock is already running, so it is not.
          click('button', 'Tiếp');
          expect(hud()).toContain('Câu 2/5');
          expect(game().paused()).toBeFalse();
          expect(pauseButton().disabled).toBeTrue();
        });

        it('is offered when the server sets no time limit', () => {
          serve({ timeMode: 'unlimited' });
          openShared(lan);
          startStage();

          expect(hud()).toContain('⏱ ∞');
          expect(pauseButton().disabled).toBeFalse();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
          fixture.detectChanges();
          expect(game().paused()).toBeTrue();
        });

        it('is still offered in a run that is not on the server', () => {
          playDemo();
          click('.stage-card', 'Màn 1');
          click('button', 'Bắt đầu');

          expect(pauseButton().disabled).toBeFalse();
        });
      });

      describe('the server\'s clock', () => {
        it('ends a question at the deadline even though the game never says it is ready', () => {
          openShared(lan);
          startStage();
          game().ready.set(false);

          // Receipt at 5000 ms + 12 s + 5 s of grace - 1 s = 21000 ms.
          tickFrames(15900);
          expect(shared.answer).not.toHaveBeenCalled();
          tickFrames(200);

          expect(shared.answer).toHaveBeenCalledOnceWith(CODE, 'run-1', 0, null);
          expect(text()).toContain('Hết giờ');
        });

        it('keeps the page\'s own clock still while the game is not ready, and shows the smaller of the two clocks', () => {
          openShared(lan);
          startStage();
          game().ready.set(false);

          tickFrames(9500);

          // 12 s on the page's clock, which has not moved; 6.5 s to the deadline.
          expect(hud()).toContain('⏱ 7s');
          expect(shared.answer).not.toHaveBeenCalled();
        });

        it('runs the page\'s clock when the game is ready, and the HUD follows it while it is the smaller', () => {
          openShared(lan);
          startStage();

          tickFrames(3600);

          expect(hud()).toContain('⏱ 9s');
        });

        it('takes the time from when the question arrived: a question dealt again has the deadline of its receipt', () => {
          openShared(lan);
          startStage();
          game().choose.emit(rightChoice());
          fixture.detectChanges();
          clock += 30000;
          shared.nextQuestion.and.returnValue(of({
            ...dealt(server.run!, 1),
            timeLeftMs: 4000
          }));
          click('button', 'Tiếp');
          game().ready.set(false);

          // Dealt at 35000 ms with 4 s left and 5 s of grace: the deadline is at 43000 ms.
          tickFrames(7800);
          expect(shared.answer).toHaveBeenCalledTimes(1);
          tickFrames(300);

          expect(shared.answer).toHaveBeenCalledTimes(2);
          expect(shared.answer.calls.mostRecent().args.slice(2)).toEqual([1, null]);
        });

        it('has no deadline when the server sets no limit', () => {
          serve({ timeMode: 'unlimited' });
          openShared(lan);
          startStage();
          game().ready.set(false);

          tickFrames(120000);

          expect(shared.answer).not.toHaveBeenCalled();
        });
      });

      it('learns from the server what it has passed after a 409 Stage locked', () => {
        const passedOne = of(sharedQuiz({
          results: {
            '1': {
              correct: 5,
              total: 5,
              passed: true
            }
          }
        }));
        // Opening the quiz and the check before the stage see stage 1 passed; the answer after the refusal does not.
        shared.load.and.returnValues(passedOne, passedOne, of(sharedQuiz()));
        openShared(lan);
        click('.stage-card', 'Màn 2');
        shared.startRun.and.returnValue(httpError(409, 'Stage locked'));

        click('button', 'Bắt đầu');

        expect(shared.load).toHaveBeenCalledTimes(3);
        expect(stageCards().map(card => card.disabled)).toEqual([false, true, true, true, true, true]);
      });

      describe('when the server refuses to start the run', () => {
        beforeEach(() => {
          openShared(lan);
          click('.stage-card', 'Màn 1');
        });

        it('shows the closed card on a 410', () => {
          shared.startRun.and.returnValue(httpError(410, 'Assignment closed'));

          click('button', 'Bắt đầu');

          expect(text()).toContain('Bài này đã đóng. Cảm ơn bạn đã tham gia!');
          expect(element().querySelector('main a')).toBeNull();
          expect(stageCards().length).toBe(0);
        });

        it('shows the board of a student who joined on the closed card', () => {
          shared.startRun.and.returnValue(httpError(410, 'Assignment closed'));
          shared.leaderboard.calls.reset();

          click('button', 'Bắt đầu');

          expect(shared.leaderboard).toHaveBeenCalledWith(CODE);
          expect(element().querySelector('.closed-board')).not.toBeNull();
        });

        it('asks a student the teacher removed to join again on a 403', () => {
          shared.startRun.and.callFake(() => {
            // The service forgets the student on a 403 before it rethrows.
            stored = null;
            return httpError(403, 'Unknown player');
          });

          click('button', 'Bắt đầu');

          expect(element().querySelector('app-share-join')).not.toBeNull();
          expect(element().querySelector('.intro')).toBeNull();
          expect(vision.stopCamera).toHaveBeenCalled();
        });

        it('says the link is wrong on a 404', () => {
          shared.startRun.and.returnValue(httpError(404, 'Assignment not found'));

          click('button', 'Bắt đầu');

          expect(text()).toContain('Không tìm thấy bài này.');
        });

        it('goes back to the map and says the stage is not open on a 409 Stage locked', () => {
          shared.startRun.and.returnValue(httpError(409, 'Stage locked'));

          click('button', 'Bắt đầu');

          expect(stageCards().length).toBe(6);
          expect(element().querySelector('.intro')).toBeNull();
          expect(notifications.warning).toHaveBeenCalledOnceWith('Màn này chưa mở', jasmine.any(String), jasmine.anything());
        });

        it('stays on the intro and says so on a failed connection, so Bắt đầu is there to try again', () => {
          shared.startRun.and.returnValue(httpError(0));

          click('button', 'Bắt đầu');

          expect(element().querySelector('.intro')).not.toBeNull();
          expect(notifications.error).toHaveBeenCalledOnceWith(
            'Chưa bắt đầu được màn', 'Mất kết nối.', jasmine.anything());
          const button = Array.from(element().querySelectorAll('button')).find(b => b.textContent?.includes('Bắt đầu'))!;
          expect(button.classList).not.toContain('ant-btn-loading');

          shared.startRun.and.callFake(startOnServer);
          click('button', 'Bắt đầu');
          expect(element().querySelector('app-true-false-game')).not.toBeNull();
        });

        it('stays on the intro on any other failure', () => {
          shared.startRun.and.returnValue(httpError(400, 'Invalid stage.'));

          click('button', 'Bắt đầu');

          expect(element().querySelector('.intro')).not.toBeNull();
          expect(notifications.error).toHaveBeenCalledTimes(1);
        });

        it('returns to the intro, not to a spinner, when a replay could not be started', () => {
          click('button', 'Về bản đồ');
          playStageOne(wrongChoice);
          shared.startRun.and.returnValue(httpError(500));

          click('button', 'Chơi lại màn');

          expect(element().querySelector('.intro')).not.toBeNull();
          expect(element().querySelector('nz-spin')).toBeNull();
          expect(notifications.error).toHaveBeenCalledTimes(1);
        });
      });

      describe('when the server refuses an answer or the next question', () => {
        beforeEach(() => {
          openShared(lan);
          startStage();
        });

        it('shows the closed card on a 410', () => {
          shared.answer.and.returnValue(httpError(410, 'Assignment closed'));

          game().choose.emit(rightChoice());
          fixture.detectChanges();

          expect(text()).toContain('Bài này đã đóng. Cảm ơn bạn đã tham gia!');
          expect(element().querySelector('.stage[data-game]')).toBeNull();
          expect(vision.stopCamera).toHaveBeenCalled();
        });

        it('asks a student the teacher removed to join again on a 403', () => {
          shared.answer.and.callFake(() => {
            stored = null;
            return httpError(403, 'Unknown player');
          });

          game().choose.emit(rightChoice());
          fixture.detectChanges();

          expect(element().querySelector('app-share-join')).not.toBeNull();
          expect(element().querySelector('.stage[data-game]')).toBeNull();
        });

        it('says the link is wrong on a 404 that is not about the run', () => {
          shared.answer.and.returnValue(httpError(404, 'Assignment not found'));

          game().choose.emit(rightChoice());
          fixture.detectChanges();

          expect(text()).toContain('Không tìm thấy bài này.');
        });

        it('says the run is over and goes back to the map on a 404 Run not found', () => {
          shared.answer.and.returnValue(httpError(404, 'Run not found'));

          game().choose.emit(rightChoice());
          fixture.detectChanges();

          expect(stageCards().length).toBe(6);
          expect(notifications.warning).toHaveBeenCalledOnceWith(
            'Lượt chơi đã kết thúc',
            'Có thể bạn đã mở màn này ở tab khác.',
            jasmine.anything());
          expect(vision.stopCamera).toHaveBeenCalled();
        });

        it('does the same when the next question is refused because the run is over', () => {
          game().choose.emit(rightChoice());
          fixture.detectChanges();
          shared.nextQuestion.and.returnValue(httpError(409, 'Run is over'));

          click('button', 'Tiếp');

          expect(stageCards().length).toBe(6);
          expect(notifications.warning).toHaveBeenCalledTimes(1);
        });

        it('does the same when the server will not take the answer', () => {
          shared.answer.and.returnValue(httpError(400, 'Invalid answer.'));

          game().choose.emit(rightChoice());
          fixture.detectChanges();

          expect(stageCards().length).toBe(6);
          expect(notifications.warning).toHaveBeenCalledTimes(1);
        });
      });

      describe('when the connection fails', () => {
        it('keeps the question, says the connection was lost and offers "Thử lại" for the answer', () => {
          shared.answer.and.returnValue(httpError(0));
          openShared(lan);
          startStage();

          game().choose.emit(rightChoice());
          fixture.detectChanges();

          expect(text()).toContain('Mất kết nối');
          expect(element().querySelector('.stage[data-game]')).not.toBeNull();
          expect(game().reveal()).toBeNull();
          expect(text()).not.toContain('Đang chờ kết quả…');
          expect(element().querySelector('.feedback')?.getAttribute('data-kind')).toBe('wrong');
          const retry = Array.from(element().querySelectorAll('.feedback button')).find(b => b.textContent?.includes('Thử lại'));
          expect(retry).toBeDefined();
          expect(element().querySelector('.feedback')?.textContent).not.toContain('Tiếp');
        });

        it('sends the same answer again from "Thử lại", and shows the verdict', () => {
          shared.answer.and.returnValue(httpError(503));
          openShared(lan);
          startStage();
          const choice = rightChoice();
          game().choose.emit(choice);
          fixture.detectChanges();
          shared.answer.and.callFake(answerOnServer);

          click('.feedback button', 'Thử lại');

          expect(shared.answer).toHaveBeenCalledTimes(2);
          expect(shared.answer.calls.argsFor(1)).toEqual(shared.answer.calls.argsFor(0));
          expect(text()).not.toContain('Mất kết nối');
          expect(text()).toContain('Chính xác! +10');
          expect(game().reveal()).not.toBeNull();
        });

        it('ignores input and the clock while it waits for "Thử lại", and again once that has failed', () => {
          shared.answer.and.returnValue(httpError(0));
          openShared(lan);
          startStage();
          game().choose.emit(rightChoice());
          fixture.detectChanges();

          game().choose.emit(wrongChoice());
          tickFrames(30000);
          expect(shared.answer).toHaveBeenCalledTimes(1);

          click('.feedback button', 'Thử lại');
          expect(shared.answer).toHaveBeenCalledTimes(2);
          expect(text()).toContain('Mất kết nối');
          game().choose.emit(wrongChoice());
          tickFrames(30000);
          expect(shared.answer).toHaveBeenCalledTimes(2);
        });

        it('sends the time-up again as a time-up', () => {
          shared.answer.and.returnValue(httpError(0));
          openShared(lan);
          startStage();
          tickFrames(12500);
          expect(shared.answer).toHaveBeenCalledOnceWith(CODE, 'run-1', 0, null);
          shared.answer.and.callFake(answerOnServer);

          click('.feedback button', 'Thử lại');

          expect(shared.answer.calls.mostRecent().args).toEqual([CODE, 'run-1', 0, null]);
          expect(text()).toContain('Hết giờ');
        });

        it('keeps the verdict and offers "Thử lại" instead of "Tiếp" when the next question cannot be fetched', () => {
          openShared(lan);
          startStage();
          game().choose.emit(rightChoice());
          fixture.detectChanges();
          shared.nextQuestion.and.returnValue(httpError(502));

          click('button', 'Tiếp');

          expect(text()).toContain('Chính xác!');
          expect(text()).toContain('Mất kết nối');
          expect(element().querySelector('.feedback')?.textContent).not.toContain('Tiếp');
          expect(hud()).toContain('Câu 1/5');

          // The loop does not keep asking.
          tickFrames(10000);
          expect(shared.nextQuestion).toHaveBeenCalledTimes(1);

          shared.nextQuestion.and.callFake(() => of(dealt(server.run!, 1)));
          click('.feedback button', 'Thử lại');

          expect(shared.nextQuestion).toHaveBeenCalledTimes(2);
          expect(hud()).toContain('Câu 2/5');
          expect(text()).not.toContain('Mất kết nối');
          expect(game().reveal()).toBeNull();
        });
      });

      describe('a request that outlives its run', () => {
        it('does not show an answer that arrives after the student went back to the map', () => {
          const verdict = new Subject<SharedVerdict>();
          shared.answer.and.returnValue(verdict);
          openShared(lan);
          startStage();
          const choice = rightChoice();
          game().choose.emit(choice);
          click('button[aria-label="Về bản đồ"]');
          audio.play.calls.reset();

          verdict.next(judgeOnServer(0, choice));
          fixture.detectChanges();

          expect(stageCards().length).toBe(6);
          expect(element().querySelector('.stage[data-game]')).toBeNull();
          expect(audio.play).not.toHaveBeenCalled();
        });

        it('does not start a run that comes back after the student left the intro', () => {
          const start = new Subject<SharedRunStart>();
          shared.startRun.and.returnValue(start);
          openShared(lan);
          click('.stage-card', 'Màn 1');
          click('button', 'Bắt đầu');
          click('button', 'Về bản đồ');

          start.next({
            runId: 'r',
            stage: 1,
            total: 5,
            attempts: 1,
            question: {
              index: 0,
              question: 'Q',
              options: ['Đúng', 'Sai'],
              timeLeftMs: 12000,
              graceMs: 5000
            }
          });
          fixture.detectChanges();

          expect(stageCards().length).toBe(6);
          expect(element().querySelector('.stage[data-game]')).toBeNull();
        });

        it('does not let the answer to an older run land on a newer one', () => {
          const old = new Subject<SharedVerdict>();
          shared.answer.and.returnValue(old);
          openShared(lan);
          startStage();
          const choice = rightChoice();
          game().choose.emit(choice);
          click('button[aria-label="Về bản đồ"]');
          shared.answer.and.callFake(answerOnServer);
          startStage();
          expect(hud()).toContain('Câu 1/5');

          old.next(judgeOnServer(0, choice));
          fixture.detectChanges();

          expect(game().reveal()).toBeNull();
          expect(hud()).toContain('⭐ 0');
        });

        it('does not show an answer that arrives for another quiz once the route has changed', () => {
          const verdict = new Subject<SharedVerdict>();
          shared.answer.and.returnValue(verdict);
          openShared(lan);
          startStage();
          const choice = rightChoice();
          game().choose.emit(choice);

          params.next(convertToParamMap({}));
          fixture.detectChanges();
          verdict.next(judgeOnServer(0, choice));
          fixture.detectChanges();

          expect(text()).toContain('Mở file quiz');
          expect(element().querySelector('.stage[data-game]')).toBeNull();
        });

        it('does not show a question that arrives after the run was left', () => {
          openShared(lan);
          startStage();
          game().choose.emit(rightChoice());
          fixture.detectChanges();
          const dealtNext = new Subject<SharedQuestion>();
          shared.nextQuestion.and.returnValue(dealtNext);
          click('button', 'Tiếp');
          click('button[aria-label="Về bản đồ"]');

          dealtNext.next(dealt(server.run!, 1));
          fixture.detectChanges();

          expect(stageCards().length).toBe(6);
          expect(element().querySelector('.stage[data-game]')).toBeNull();
        });
      });

      describe('the other modes still judge in the page', () => {
        it('plays a file or the sample without asking the server for anything', () => {
          playDemo();

          playStageOne(rightChoice);

          expect(text()).toContain('Qua màn 1!');
          expect(text()).not.toContain('Đã lưu kết quả cho thầy cô');
          expect(shared.startRun).not.toHaveBeenCalled();
          expect(shared.nextQuestion).not.toHaveBeenCalled();
          expect(shared.answer).not.toHaveBeenCalled();
        });

        it('keeps the pause of a local run, however much time it has', () => {
          playDemo();
          click('.stage-card', 'Màn 1');
          click('button', 'Bắt đầu');

          expect(pauseButton().disabled).toBeFalse();
        });
      });
    });
  });

  // The teacher on /play/preview/:assignmentId.
  describe('a preview (the teacher)', () => {
    function openPreview(): void {
      params.next(convertToParamMap({ assignmentId: 'a1' }));
      open();
    }

    const stageCards = (): HTMLButtonElement[] =>
      Array.from(element().querySelectorAll<HTMLButtonElement>('.stage-card'));

    it('plays the assignment\'s quiz with every stage open and says nothing is kept', () => {
      openPreview();

      expect(assignments.get).toHaveBeenCalledWith('a1');
      expect(shared.load).not.toHaveBeenCalled();
      expect(stageCards().length).toBe(6);
      expect(stageCards().map(card => card.disabled)).toEqual([false, false, false, false, false, false]);
      expect(text()).toContain('👁 Xem thử: mọi màn đều mở, không lưu kết quả.');
      expect(element().querySelector('.title')?.textContent).toContain('HSK1 bài 1 · Lớp 6A');
    });

    it('shows the board students see under the map, read by the assignment\'s code', () => {
      shared.leaderboard.and.returnValue(of(studentBoard({
        top: [{
          rank: 1,
          name: 'Minh',
          avatar: 'dragon',
          stagesPassed: 3,
          correct: 14
        }],
      })));
      openPreview();

      expect(shared.leaderboard).toHaveBeenCalledOnceWith(CODE);
      const board = element().querySelector('app-student-leaderboard')!;
      expect(board).not.toBeNull();
      expect(board.textContent).toContain('Bảng xếp hạng');
      expect(board.querySelector('li.step')?.textContent).toContain('Minh');
      expect(element().querySelector('app-gesture-stage-map')!.compareDocumentPosition(board)
        & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('mounts no board, and reads none, when the assignment hid it from the students', () => {
      assignments.get.and.returnValue(of(assignmentDetail({ showBoard: false })));
      openPreview();

      expect(stageCards().length).toBe(6);
      expect(element().querySelector('app-student-leaderboard')).toBeNull();
      expect(shared.leaderboard).not.toHaveBeenCalled();
    });

    it('has no avatar button or "Không phải bạn?", since the teacher is nobody\'s student', () => {
      openPreview();

      expect(element().querySelector('.avatar-button')).toBeNull();
      expect(text()).not.toContain('Không phải bạn?');
    });

    it('does not read the board when the assignment could not be loaded', () => {
      assignments.get.and.returnValue(httpError(500));
      openPreview();

      expect(element().querySelector('app-student-leaderboard')).toBeNull();
      expect(shared.leaderboard).not.toHaveBeenCalled();
    });

    it('goes back to the leaderboard from the topbar', () => {
      openPreview();

      const back = element().querySelector<HTMLAnchorElement>('.back-link')!;
      expect(back.getAttribute('href')).toBe('/assignments/a1');
      expect(back.textContent).toContain('Về bảng xếp hạng');
    });

    it('opens a later stage straight away, without passing the earlier ones', () => {
      openPreview();

      click('.stage-card', 'Màn 3');

      expect(text()).toContain('Ếch đớp chữ');
      click('button', 'Bắt đầu');
      expect(game().question().stage).toBe(3);
    });

    it('uses the teacher\'s time mode, and shows it as text', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        timeMode: 'unlimited',
        sound: true,
        useCamera: false
      }));
      assignments.get.and.returnValue(of(assignmentDetail({ timeMode: 'extra' })));
      openPreview();

      expect(text()).toContain('Thời gian mỗi câu: Thêm thời gian (×1.5)');
      expect(element().querySelector('.reset-button')).toBeNull();
      click('.stage-card', 'Màn 1');
      expect(text()).toContain('18 giây mỗi câu');
    });

    it("uses the server's time limits of the assignment for the intro and for the clock of the local run", () => {
      assignments.get.and.returnValue(of(assignmentDetail({
        timeLimits: {
          '1': 8,
          '2': 8,
          '3': 9,
          '4': 9,
          '5': 11,
          '6': 30
        }
      })));
      openPreview();

      click('.stage-card', 'Màn 1');
      expect(text()).toContain('8 giây mỗi câu');
      expect(text()).not.toContain('12 giây');
      click('button', 'Bắt đầu');
      expect(normalized('.hud')).toContain('⏱ 8s');

      // The page's animation loop does not run inside a synchronous spec: its frames are driven by hand.
      const frame = (now: number): void => (fixture.componentInstance as unknown as {
        frame(now: number): void
      }).frame(now);
      let now = 1000;
      for (; now < 8500; now += 100) {
        frame(now);
      }
      fixture.detectChanges();
      expect(text()).not.toContain('Hết giờ');

      for (; now < 10000; now += 100) {
        frame(now);
      }
      fixture.detectChanges();
      expect(text()).toContain('Hết giờ');
      expect(shared.answer).not.toHaveBeenCalled();
    });

    it('says there is no limit when the assignment sends none for the stage', () => {
      assignments.get.and.returnValue(of(assignmentDetail({
        timeLimits: {
          '1': null,
          '2': 8,
          '3': 9,
          '4': 9,
          '5': 11,
          '6': 30
        }
      })));
      openPreview();

      click('.stage-card', 'Màn 1');
      expect(text()).toContain('không giới hạn thời gian');
      click('button', 'Bắt đầu');

      expect(normalized('.hud')).toContain('⏱ ∞');
    });

    it('judges a run by the percentages of the assignment, without writing progress', () => {
      assignments.get.and.returnValue(of(assignmentDetail({
        passPercents: {
          1: 50,
          2: 70,
          3: 70,
          4: 70,
          5: 70,
          6: 70
        }
      })));
      openPreview();

      click('.stage-card', 'Màn 1');
      expect(text()).toContain('Đúng ít nhất 3/5');
      click('button', 'Bắt đầu');
      let asked = 0;
      for (let question = 0; question < 5; question += 1) {
        game().choose.emit(asked++ < 3 ? rightChoice() : anyWrongChoice());
        fixture.detectChanges();
        click('button', 'Tiếp');
      }

      expect(text()).toContain('Qua màn 1!');
      expect(text()).toContain('Đúng ít nhất 3/5');
      expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
    });

    it('sends nothing and writes no progress, but offers the next stage after a failed run too', () => {
      openPreview();

      playStageOne(wrongChoice);

      expect(text()).toContain('Chưa qua màn 1');
      expect(text()).toContain('Xem thử: kết quả không được lưu.');
      expect(text()).toContain('Màn tiếp theo');
      expect(shared.startRun).not.toHaveBeenCalled();
      expect(shared.nextQuestion).not.toHaveBeenCalled();
      expect(shared.answer).not.toHaveBeenCalled();
      expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
    });

    it('never limits the runs, whatever the assignment says', () => {
      assignments.get.and.returnValue(of(assignmentDetail({
        stageLock: 'open',
        maxAttempts: 1
      })));
      openPreview();

      expect(stageCards().some(card => /lượt/.test(card.textContent ?? ''))).toBeFalse();
      playStageOne(wrongChoice);
      expect(text()).toContain('Chơi lại màn');
      click('button', 'Chơi lại màn');
      for (let question = 0; question < 5; question += 1) {
        game().choose.emit(wrongChoice());
        fixture.detectChanges();
        click('button', 'Tiếp');
      }

      expect(text()).toContain('Chơi lại màn');
      expect(text()).not.toContain('Bạn đã dùng hết lượt');
      click('button', 'Về bản đồ');
      expect(stageCards().every(card => !card.disabled)).toBeTrue();
    });

    it('does not check the server before a stage', () => {
      openPreview();

      click('.stage-card', 'Màn 1');

      expect(shared.load).not.toHaveBeenCalled();
      expect(text()).toContain('Đúng ít nhất 4/5');
    });

    it('shows the banner on the intro and on the stage too', () => {
      openPreview();
      click('.stage-card', 'Màn 1');
      expect(text()).toContain('Xem thử: mọi màn đều mở');

      click('button', 'Bắt đầu');
      expect(text()).toContain('Xem thử: mọi màn đều mở');
    });

    it('offers the leaderboard when the assignment cannot be loaded', () => {
      assignments.get.and.returnValue(httpError(500));
      openPreview();

      expect(text()).toContain('Không tải được bài này.');
      const link = element().querySelector<HTMLAnchorElement>('main a.ant-btn-primary')!;
      expect(link.getAttribute('href')).toBe('/assignments/a1');
      expect(link.textContent).toContain('Về bảng xếp hạng');
      expect(text()).not.toContain('Xem thử: mọi màn đều mở');
    });

    it('offers the list when the assignment does not exist any more', () => {
      assignments.get.and.returnValue(httpError(404, 'Assignment not found'));
      openPreview();

      expect(text()).toContain('Không tải được bài này.');
      expect(element().querySelector('main a.ant-btn-primary')?.getAttribute('href')).toBe('/assignments');
    });
  });
});
