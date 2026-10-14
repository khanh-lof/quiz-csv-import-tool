import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { BehaviorSubject, of, Subject, throwError } from 'rxjs';
import { DEMO_QUIZ_CSV } from '../../game/demo-quiz';
import { GameAudio } from '../../game/game-audio';
import { StageGameBase, VisionKind } from '../../game/stage-game';
import { CameraState, ModelState, VisionService } from '../../game/vision.service';
import { AiJob } from '../../models/ai-job';
import { AssignmentDetail, PlayerIdentity, SharedQuiz, SubmitOutcome } from '../../models/assignment';
import { ExportType } from '../../models/export-type';
import { parseGestureQuiz } from '../../models/gesture-quiz';
import { AiJobService } from '../../services/ai-job.service';
import { AssignmentService } from '../../services/assignment.service';
import { CsvImportService } from '../../services/csv-import.service';
import { SharedPlayService } from '../../services/shared-play.service';
import { GesturePlay } from './gesture-play';
import { ShareJoin } from './share-join/share-join';

const PROGRESS_KEY = 'gesture-quiz-progress';
const SETTINGS_KEY = 'gesture-quiz-settings';

// A camera and recognition stand-in: the page is tested here, not MediaPipe or a real webcam.
class FakeVision {
  readonly video = document.createElement('video');
  readonly cameraState = signal<CameraState>('off');
  readonly cameraMessage = signal('');
  private readonly models = { hand: signal<ModelState>('idle'), face: signal<ModelState>('idle') };

  readonly startCamera = jasmine.createSpy('startCamera').and.callFake(async () => this.cameraState.set('on'));
  readonly stopCamera = jasmine.createSpy('stopCamera').and.callFake(() => this.cameraState.set('off'));
  readonly ensureModel = jasmine
    .createSpy('ensureModel')
    .and.callFake(async (kind: VisionKind) => this.models[kind].set('ready'));
  readonly detect = jasmine.createSpy('detect').and.returnValue(null);

  modelState(kind: VisionKind) {
    return this.models[kind];
  }

  videoSize() {
    return { width: 640, height: 480 };
  }
}

// The sample's rows of only some stages, the way a quiz made with a choice of games looks: the CSV keeps
// the stages' own numbers (4 and 6), so only what is shown is renumbered.
function sampleStages(...stages: number[]): string {
  return DEMO_QUIZ_CSV.split('\n').filter(line => stages.some(stage => line.startsWith(`${stage},`))).join('\n');
}

function gestureJob(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: 'job-1', status: 'done', title: 'HSK1 bài 1', creative: true, exportType: ExportType.GestureQuiz,
    intelligence: 1, imageCount: 0, courseType: null, courseName: '', hskStandard: null, level: null,
    lessonNumber: null, csv: DEMO_QUIZ_CSV, errorStatus: 0, errorMessage: '', createdAt: '2026-10-13T00:00:00Z',
    finishedAt: null, ...overrides,
  };
}

// A student's quiz and a teacher's assignment, both made of the sample's questions.
const CODE = 'ABC123DEF4';

function sharedQuiz(overrides: Partial<SharedQuiz> = {}): SharedQuiz {
  return { title: 'HSK1 bài 1', label: 'Lớp 6A', csv: DEMO_QUIZ_CSV, timeMode: 'standard', closesAt: null, ...overrides };
}

function assignmentDetail(overrides: Partial<AssignmentDetail> = {}): AssignmentDetail {
  return {
    id: 'a1', code: CODE, jobId: 'job-1', title: 'HSK1 bài 1', label: 'Lớp 6A', timeMode: 'standard',
    stageCounts: { 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5 }, createdAt: '2026-10-14T00:00:00Z', closesAt: null,
    closedAt: null, open: true, playerCount: 0, csv: DEMO_QUIZ_CSV, players: [], ...overrides,
  };
}

const httpError = (status: number, body = '') =>
  throwError(() => new HttpErrorResponse({ status, error: body || null }));

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

  beforeEach(() => {
    localStorage.removeItem(PROGRESS_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    vision = new FakeVision();
    audio = jasmine.createSpyObj<GameAudio>('GameAudio', ['play', 'resume', 'setMuted']);
    notifications = jasmine.createSpyObj('NzNotificationService', ['warning', 'success', 'error']);
    params = new BehaviorSubject(convertToParamMap({}));
    jobs = { jobs: signal<AiJob[]>([]), refresh: jasmine.createSpy('refresh').and.returnValue(of([])) };
    stored = null;
    shared = jasmine.createSpyObj<SharedPlayService>(
      'SharedPlayService', ['load', 'join', 'identity', 'forget', 'submit', 'flush', 'pendingCount']);
    shared.load.and.callFake(() => of(sharedQuiz()));
    shared.identity.and.callFake(() => stored);
    shared.forget.and.callFake(() => {
      stored = null;
    });
    shared.join.and.callFake((_code: string, name: string) => {
      const identity: PlayerIdentity = { playerId: `p-${name.toLowerCase()}`, token: 'token', name };
      stored = identity;
      return of(identity);
    });
    shared.submit.and.returnValue(of<SubmitOutcome>('saved'));
    shared.flush.and.returnValue(of(undefined));
    shared.pendingCount.and.returnValue(0);
    assignments = jasmine.createSpyObj<AssignmentService>('AssignmentService', ['get']);
    assignments.get.and.callFake(() => of(assignmentDetail()));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { paramMap: params } },
        { provide: VisionService, useValue: vision },
        { provide: GameAudio, useValue: Object.assign(audio, { muted: signal(false) }) },
        { provide: NzNotificationService, useValue: notifications },
        { provide: AiJobService, useValue: jobs },
        { provide: SharedPlayService, useValue: shared },
        { provide: AssignmentService, useValue: assignments },
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
        'Quiz có 6 màn, 30 câu hỏi, chơi từ dễ đến khó. Mỗi màn cần đúng từ 70% số câu để mở màn sau.');
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
        [[gestureJob({ exportType: ExportType.Wayground })], 'không phải quiz cử chỉ'],
        [[gestureJob({ csv: 'không phải quiz' })], 'Không tìm thấy câu hỏi'],
      ];
      for (const [list, message] of cases) {
        jobs.jobs.set(list);
        params.next(convertToParamMap({ jobId: 'job-1' }));
        open();

        expect(text()).withContext(message).toContain(message);
        expect(element().querySelector('a[href="/ai"].ant-btn-primary')).withContext(message).not.toBeNull();
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
      expect(text()).toContain('Cần đúng ít nhất 4/5');

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
      expect(game().reveal()).toEqual(jasmine.objectContaining({ chosen: choice, correct: true, correctIndex: choice as number }));
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
      expect(text()).toContain('Cần đúng ít nhất 4/5');
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
            best: Object.fromEntries(stages.map(stage => [stage, { correct: 5, total: 5 }])),
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
        'Quiz có 2 màn, 10 câu hỏi, chơi từ dễ đến khó. Mỗi màn cần đúng từ 70% số câu để mở màn sau.');
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
            best: { 4: { correct: 5, total: 5 }, 6: { correct: 4, total: 5 } },
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
      expect(normalized('.summary')).toBe('Quiz có 1 màn, 5 câu hỏi. Đúng từ 70% số câu là qua màn.');
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
        csv: sampleStages(4, 6), stageCounts: { 4: 5, 6: 5 },
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

    it('explains in the guide that a quiz has one to six stages', () => {
      open();
      // The guide's text is in a popup, which exists only once it is opened.
      click('.guide-button');

      const guide = document.querySelector('.usage-guide')?.textContent ?? '';
      expect(guide).toContain('từ 1 đến 6 màn');
      expect(guide).not.toContain('Quiz có 6 màn');
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
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ timeMode: 'standard', sound: true, useCamera: true }));
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
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ timeMode: 'extra', sound: true, useCamera: false }));
      playDemo();
      click('.stage-card', 'Màn 1');

      expect(text()).toContain('18 giây mỗi câu');
    });

    it('has no limit in unlimited mode', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ timeMode: 'unlimited', sound: true, useCamera: false }));
      playDemo();
      click('.stage-card', 'Màn 1');
      expect(text()).toContain('không giới hạn thời gian');

      click('button', 'Bắt đầu');
      expect(text()).toContain('⏱ ∞');
    });

    it('mutes the shared audio when the sound was turned off last time', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ timeMode: 'standard', sound: false, useCamera: false }));
      open();

      expect(audio.setMuted).toHaveBeenCalledWith(true);
    });
  });

  // A student on /play/s/:code. `stored` is who this device joined the quiz as before, if anyone.
  describe('a shared quiz (a student)', () => {
    const SAVED_KEY = `asg:${CODE}:p-lan`;
    const lan: PlayerIdentity = { playerId: 'p-lan', token: 'token', name: 'Lan' };

    function openShared(identity: PlayerIdentity | null = null): void {
      stored = identity;
      // The link's code may be typed in lower case: it is read case-insensitively.
      params.next(convertToParamMap({ code: CODE.toLowerCase() }));
      open();
    }

    function joinAs(name: string): void {
      fixture.debugElement.query(By.directive(ShareJoin)).componentInstance.join.emit(name);
      fixture.detectChanges();
    }

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
        expect(shared.flush).not.toHaveBeenCalled();
      });

      it('joins with the name given and goes to the map, naming the student', () => {
        openShared();

        joinAs('Lan');

        expect(shared.join).toHaveBeenCalledWith(CODE, 'Lan');
        expect(element().querySelector('app-share-join')).toBeNull();
        expect(stageCards().length).toBe(6);
        expect(text()).toContain('👤 Lan · Không phải bạn?');
        // Whatever an earlier visit left in the queue is sent now that the student is known.
        expect(shared.flush).toHaveBeenCalledWith(CODE);
      });

      it('skips the join screen on a device that has joined, and sends what was left in the queue', () => {
        openShared(lan);

        expect(element().querySelector('app-share-join')).toBeNull();
        expect(stageCards().length).toBe(6);
        expect(text()).toContain('👤 Lan');
        expect(shared.flush).toHaveBeenCalledOnceWith(CODE);
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
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ timeMode: 'standard', sound: true, useCamera: false }));
        shared.load.and.returnValue(of(sharedQuiz({ timeMode: 'extra' })));
        openShared(lan);

        expect(text()).toContain('Thời gian mỗi câu: Thêm thời gian (×1.5) (thầy cô đặt)');
        expect(element().querySelector('nz-radio-group')).toBeNull();
        expect(element().querySelector('.reset-button')).toBeNull();
        // The sound switch is the student's own.
        expect(element().querySelector('nz-switch')).not.toBeNull();
      });

      it('times the questions by the teacher\'s time mode, not the student\'s own', () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ timeMode: 'unlimited', sound: true, useCamera: false }));
        shared.load.and.returnValue(of(sharedQuiz({ timeMode: 'extra' })));
        openShared(lan);

        click('.stage-card', 'Màn 1');

        expect(text()).toContain('18 giây mỗi câu');
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
        expect(text()).toContain('Cần đúng ít nhất 4/5');
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
        expect(text()).toContain('Cần đúng ít nhất 4/5');
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

      it('still opens the stage when the server cannot be reached, so the student can play on', () => {
        openShared(lan);
        shared.load.and.returnValue(httpError(0));

        click('.stage-card', 'Màn 1');

        expect(text()).toContain('Cần đúng ít nhất 4/5');
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

    describe('saving a result', () => {
      it('sends the finished stage with its numbers and says it was saved', () => {
        openShared(lan);

        playStageOne(rightChoice);

        expect(shared.submit).toHaveBeenCalledOnceWith(CODE, { stage: 1, correct: 5, total: 5 });
        expect(text()).toContain('Qua màn 1!');
        expect(text()).toContain('Đã lưu kết quả cho thầy cô ✓');
      });

      it('sends a failed run too, with the questions it got right', () => {
        openShared(lan);

        playStageOne(wrongChoice);

        expect(shared.submit).toHaveBeenCalledOnceWith(CODE, { stage: 1, correct: 0, total: 5 });
        expect(text()).toContain('Chưa qua màn 1');
      });

      it('shows that it is saving until the server answers', () => {
        openShared(lan);
        const sent = new Subject<SubmitOutcome>();
        shared.submit.and.returnValue(sent);

        playStageOne(rightChoice);
        expect(text()).toContain('Đang lưu kết quả…');

        sent.next('saved');
        fixture.detectChanges();
        expect(text()).not.toContain('Đang lưu kết quả…');
        expect(text()).toContain('Đã lưu kết quả cho thầy cô ✓');
      });

      it('says a result that could not be sent will be sent again', () => {
        openShared(lan);
        shared.submit.and.returnValue(of<SubmitOutcome>('queued'));

        playStageOne(rightChoice);

        expect(text()).toContain('Chưa gửi được kết quả, máy sẽ tự gửi lại khi có mạng.');
      });

      it('says a result sent after the close is not kept', () => {
        openShared(lan);
        shared.submit.and.returnValue(of<SubmitOutcome>('closed'));

        playStageOne(rightChoice);

        expect(text()).toContain('Bài đã đóng nên kết quả này không được lưu.');
      });

      it('tells a removed student, and asks them to join again at the next stage', () => {
        openShared(lan);
        shared.submit.and.callFake(() => {
          stored = null;
          return of<SubmitOutcome>('rejected');
        });

        playStageOne(rightChoice);

        expect(text()).toContain('Máy chủ không nhận kết quả này.');
        expect(text()).toContain('Qua màn 1!');

        click('button', 'Màn tiếp theo');

        expect(element().querySelector('app-share-join')).not.toBeNull();
      });

      it('does not leave a removed student on the map', () => {
        openShared(lan);
        shared.submit.and.callFake(() => {
          stored = null;
          return of<SubmitOutcome>('rejected');
        });
        playStageOne(rightChoice);

        click('button', 'Về bản đồ');

        expect(element().querySelector('app-share-join')).not.toBeNull();
        expect(stageCards().length).toBe(0);
      });

      it('sends the queue again when the connection comes back, but only on a shared quiz', () => {
        openShared(lan);
        shared.flush.calls.reset();

        window.dispatchEvent(new Event('online'));

        expect(shared.flush).toHaveBeenCalledOnceWith(CODE);

        fixture.destroy();
        params.next(convertToParamMap({}));
        shared.flush.calls.reset();
        playDemo();
        window.dispatchEvent(new Event('online'));

        expect(shared.flush).not.toHaveBeenCalled();
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
      expect(text()).toContain('👁 Xem thử: mọi màn đều mở, kết quả không được lưu.');
      expect(element().querySelector('.title')?.textContent).toContain('HSK1 bài 1 · Lớp 6A');
    });

    it('goes back to the ranking from the topbar', () => {
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
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ timeMode: 'unlimited', sound: true, useCamera: false }));
      assignments.get.and.returnValue(of(assignmentDetail({ timeMode: 'extra' })));
      openPreview();

      expect(text()).toContain('Thời gian mỗi câu: Thêm thời gian (×1.5) (thầy cô đặt)');
      expect(element().querySelector('.reset-button')).toBeNull();
      click('.stage-card', 'Màn 1');
      expect(text()).toContain('18 giây mỗi câu');
    });

    it('sends nothing and writes no progress, but offers the next stage after a failed run too', () => {
      openPreview();

      playStageOne(wrongChoice);

      expect(text()).toContain('Chưa qua màn 1');
      expect(text()).toContain('Xem thử: kết quả không được lưu.');
      expect(text()).toContain('Màn tiếp theo');
      expect(shared.submit).not.toHaveBeenCalled();
      expect(shared.flush).not.toHaveBeenCalled();
      expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
    });

    it('does not check the server before a stage', () => {
      openPreview();

      click('.stage-card', 'Màn 1');

      expect(shared.load).not.toHaveBeenCalled();
      expect(text()).toContain('Cần đúng ít nhất 4/5');
    });

    it('shows the banner on the intro and on the stage too', () => {
      openPreview();
      click('.stage-card', 'Màn 1');
      expect(text()).toContain('Xem thử: mọi màn đều mở');

      click('button', 'Bắt đầu');
      expect(text()).toContain('Xem thử: mọi màn đều mở');
    });

    it('offers the ranking when the assignment cannot be loaded', () => {
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
