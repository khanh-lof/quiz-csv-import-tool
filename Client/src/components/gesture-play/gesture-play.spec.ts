import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { BehaviorSubject, of } from 'rxjs';
import { DEMO_QUIZ_CSV } from '../../game/demo-quiz';
import { GameAudio } from '../../game/game-audio';
import { StageGameBase, VisionKind } from '../../game/stage-game';
import { CameraState, ModelState, VisionService } from '../../game/vision.service';
import { AiJob } from '../../models/ai-job';
import { ExportType } from '../../models/export-type';
import { parseGestureQuiz } from '../../models/gesture-quiz';
import { AiJobService } from '../../services/ai-job.service';
import { CsvImportService } from '../../services/csv-import.service';
import { GesturePlay } from './gesture-play';

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

function gestureJob(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: 'job-1', status: 'done', title: 'HSK1 bài 1', creative: true, exportType: ExportType.GestureQuiz,
    intelligence: 1, imageCount: 0, courseType: null, courseName: '', hskStandard: null, level: null,
    lessonNumber: null, csv: DEMO_QUIZ_CSV, errorStatus: 0, errorMessage: '', createdAt: '2026-10-13T00:00:00Z',
    finishedAt: null, ...overrides,
  };
}

describe('GesturePlay', () => {
  let fixture: ComponentFixture<GesturePlay>;
  let vision: FakeVision;
  let audio: jasmine.SpyObj<GameAudio>;
  let notifications: jasmine.SpyObj<NzNotificationService>;
  let params: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
  let jobs: { jobs: ReturnType<typeof signal<AiJob[]>>; refresh: jasmine.Spy };

  const demoQuiz = parseGestureQuiz(new CsvImportService().parseCsvRows(DEMO_QUIZ_CSV), 'Demo');

  beforeEach(() => {
    localStorage.removeItem(PROGRESS_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    vision = new FakeVision();
    audio = jasmine.createSpyObj<GameAudio>('GameAudio', ['play', 'resume', 'setMuted']);
    notifications = jasmine.createSpyObj('NzNotificationService', ['warning', 'success', 'error']);
    params = new BehaviorSubject(convertToParamMap({}));
    jobs = { jobs: signal<AiJob[]>([]), refresh: jasmine.createSpy('refresh').and.returnValue(of([])) };
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

  // Plays stage 1 through the page: `choose` is what the stage's game emits.
  function playStageOne(answer: () => number | string[]): void {
    click('.stage-card', 'Màn 1');
    click('button', 'Bắt đầu');
    for (let question = 0; question < 5; question += 1) {
      game().choose.emit(answer());
      fixture.detectChanges();
      click('button', 'Tiếp');
    }
  }

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
});
