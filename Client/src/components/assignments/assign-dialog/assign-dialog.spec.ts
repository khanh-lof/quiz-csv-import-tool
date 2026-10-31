import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AiJob } from '../../../models/ai-job';
import { Assignment } from '../../../models/assignment';
import { DEMO_QUIZ_CSV } from '../../../game/demo-quiz';
import { AssignDialog } from './assign-dialog';

const URL = '/api/assignments';

function job(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: 'job-1',
    status: 'done',
    title: 'Quiz HSK 1 bài 3',
    creative: true,
    exportType: 3,
    intelligence: 1,
    imageCount: 0,
    courseType: null,
    courseName: '',
    hskStandard: null,
    level: null,
    lessonNumbers: null,
    retryable: false,
    retryUntil: null,
    csv: DEMO_QUIZ_CSV,
    errorStatus: 0,
    errorMessage: '',
    createdAt: '2026-10-13T00:00:00Z',
    finishedAt: '2026-10-13T00:01:00Z', ...overrides,
  };
}

// A quiz of only stages 2 and 5 (five questions each), shown to the teacher as "Màn 1" and "Màn 2".
const TWO_STAGE_CSV = DEMO_QUIZ_CSV.split('\n').filter(line => /^[25],/.test(line)).join('\n');

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: 'asg-1',
    code: 'K7M2X9QD4P',
    jobId: 'job-1',
    title: 'Quiz HSK 1 bài 3',
    label: '',
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
    timeLimits: {
      '1': 12,
      '2': 12,
      '3': 12,
      '4': 12,
      '5': 12,
      '6': 12
    },
    createdAt: '2026-10-14T00:00:00Z',
    closesAt: null,
    closedAt: null,
    open: true,
    playerCount: 0, ...overrides,
  };
}

describe('AssignDialog', () => {
  let fixture: ComponentFixture<AssignDialog>;
  let http: HttpTestingController;
  let router: Router;
  let notifications: jasmine.SpyObj<NzNotificationService>;
  let openWindow: jasmine.Spy;
  let created: Assignment[];

  beforeEach(() => {
    notifications = jasmine.createSpyObj('NzNotificationService', ['success', 'warning', 'error']);
    TestBed.configureTestingModule({
      imports: [AssignDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: NzNotificationService,
          useValue: notifications
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    spyOn(router, 'navigateByUrl').and.resolveTo(true);
    openWindow = spyOn(window, 'open').and.returnValue(null);
    created = [];
  });

  afterEach(() => {
    // The icons are fetched as files from assets/ when first drawn, which is not what these specs are about.
    http.match(request => request.url.startsWith('assets/'));
    http.verify();
  });

  // The dialog is a modal, so its content lives in the overlay at the end of <body>, not in the fixture.
  const dialog = (): HTMLElement | null => document.body.querySelector('.ant-modal-content');
  const text = (): string => dialog()?.textContent ?? '';
  const button = (label: string): HTMLButtonElement => {
    const found = Array.from(dialog()?.querySelectorAll('button') ?? [])
      .find(candidate => candidate.textContent?.trim() === label);
    if (!found) {
      throw new Error(`No button "${label}" in: ${text()}`);
    }
    return found;
  };

  async function show(forJob: AiJob | null = job()): Promise<void> {
    fixture = TestBed.createComponent(AssignDialog);
    fixture.componentInstance.created.subscribe(made => created.push(made));
    fixture.componentRef.setInput('job', forJob);
    fixture.componentRef.setInput('open', true);
    await settle();
  }

  // A short real wait rather than whenStable(): the modal's animation keeps the zone busy, so whenStable() never
  // resolves while one is open, and the modal itself appears (and ngModel writes) a tick after the change.
  async function settle(): Promise<void> {
    fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve, 20));
    fixture.detectChanges();
  }

  async function typeLabel(value: string): Promise<void> {
    const input = dialog()!.querySelector<HTMLInputElement>('#assign-label')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  it('asks for the details of the quiz it was opened for and describes what the quiz holds', async () => {
    await show();

    expect(text()).toContain('Giao bài cho học sinh');
    expect(text()).toContain('Quiz HSK 1 bài 3');
    expect(text()).toContain('30 câu · 6 màn');
    expect(dialog()!.querySelector('#assign-label')).not.toBeNull();
    expect(dialog()!.querySelector('app-deadline-picker')).not.toBeNull();
    expect(text()).toContain('Thời gian mỗi câu');
    expect(button('Giao bài').disabled).toBeFalse();
  });

  it('sends the open stage lock when the teacher picks it', async () => {
    await show();
    const radio = Array.from(dialog()!.querySelectorAll<HTMLInputElement>('input[type=radio]'))
      .find(input => input.closest('label')?.textContent?.includes('Mở tất cả'));
    radio!.click();
    await settle();

    button('Giao bài').click();
    await settle();
    const request = http.expectOne(URL);
    expect(request.request.body.stageLock).toBe('open');
    request.flush(assignment({ stageLock: 'open' }), {
      status: 201,
      statusText: 'Created'
    });
    await settle();
  });

  describe('the pass percentages', () => {
    const percentInputs = (): HTMLInputElement[] =>
      Array.from(dialog()!.querySelectorAll<HTMLInputElement>('.pass-row input'));

    async function typePercent(index: number, value: string): Promise<void> {
      const input = percentInputs()[index];
      input.value = value;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('blur'));
      await settle();
    }

    it('lists only the stages the quiz has, by position, each at the default with what it needs', async () => {
      await show(job({ csv: TWO_STAGE_CSV }));

      const rows = Array.from(dialog()!.querySelectorAll('.pass-row'));
      expect(rows.length).toBe(2);
      expect(rows[0].textContent).toContain('Màn 1');
      expect(rows[0].textContent).toContain('Nghiêng đầu');
      expect(rows[1].textContent).toContain('Màn 2');
      expect(rows[1].textContent).toContain('Giơ ngón tay');
      expect(rows.every(row => row.textContent!.includes('cần đúng 4/5 câu'))).toBeTrue();
      expect(percentInputs().length).toBe(2);
    });

    it('lists the six stages of a full quiz', async () => {
      await show();

      expect(dialog()!.querySelectorAll('.pass-row').length).toBe(6);
    });

    it('sends the default of every stage the quiz has when nothing is changed', async () => {
      await show(job({ csv: TWO_STAGE_CSV }));

      button('Giao bài').click();
      await settle();
      const request = http.expectOne(URL);
      expect(request.request.body.passPercents).toEqual({
        '2': 70,
        '5': 70
      });
      // The server counts the quiz's questions itself, from the job's CSV: the dialog sends no counts.
      expect(request.request.body.stageCounts).toBeUndefined();
      request.flush(assignment(), {
        status: 201,
        statusText: 'Created'
      });
      await settle();
    });

    it('sends an edited percentage under the stage number, and shows what it requires', async () => {
      await show(job({ csv: TWO_STAGE_CSV }));

      await typePercent(1, '50');

      const rows = Array.from(dialog()!.querySelectorAll('.pass-row'));
      expect(rows[0].textContent).toContain('cần đúng 4/5 câu');
      expect(rows[1].textContent).toContain('cần đúng 3/5 câu');

      button('Giao bài').click();
      await settle();
      const request = http.expectOne(URL);
      expect(request.request.body.passPercents).toEqual({
        '2': 70,
        '5': 50
      });
      request.flush(assignment(), {
        status: 201,
        statusText: 'Created'
      });
      await settle();
    });

    it('reads an emptied box as the default and never sends a value outside the range', async () => {
      await show(job({ csv: TWO_STAGE_CSV }));

      await typePercent(0, '');
      await typePercent(1, '5000');
      button('Giao bài').click();
      await settle();

      const request = http.expectOne(URL);
      expect(request.request.body.passPercents).toEqual({
        '2': 70,
        '5': 100
      });
      request.flush(assignment(), {
        status: 201,
        statusText: 'Created'
      });
      await settle();
    });

    it('goes back to the defaults when the dialog is opened again', async () => {
      await show(job({ csv: TWO_STAGE_CSV }));
      await typePercent(0, '100');
      expect(Array.from(dialog()!.querySelectorAll('.pass-row'))[0].textContent).toContain('cần đúng 5/5 câu');

      fixture.componentInstance.open.set(false);
      await settle();
      fixture.componentInstance.open.set(true);
      await settle();

      expect(Array.from(dialog()!.querySelectorAll('.pass-row'))[0].textContent).toContain('cần đúng 4/5 câu');
      button('Giao bài').click();
      await settle();
      const request = http.expectOne(URL);
      expect(request.request.body.passPercents).toEqual({
        '2': 70,
        '5': 70
      });
      request.flush(assignment(), {
        status: 201,
        statusText: 'Created'
      });
      await settle();
    });

    it('tells the teacher when the server refuses the percentages', async () => {
      await show();

      button('Giao bài').click();
      await settle();
      http.expectOne(URL).flush('Invalid pass percents.', {
        status: 400,
        statusText: 'Bad Request'
      });
      await settle();

      expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain('10% đến 100%');
    });
  });

  describe('the replay limit', () => {
    const attemptsField = (): HTMLElement | null => dialog()!.querySelector('.attempts-row');
    const attemptsSwitch = (): HTMLButtonElement => attemptsField()!.querySelector<HTMLButtonElement>('button[nz-switch], .ant-switch')!;
    const attemptsInput = (): HTMLInputElement | null => dialog()!.querySelector<HTMLInputElement>('.attempts-row input');

    async function pickLock(label: string): Promise<void> {
      Array.from(dialog()!.querySelectorAll<HTMLInputElement>('input[type=radio]'))
        .find(input => input.closest('label')?.textContent?.includes(label))!.click();
      await settle();
    }

    async function typeAttempts(value: string): Promise<void> {
      const input = attemptsInput()!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('blur'));
      await settle();
    }

    async function send(): Promise<Record<string, unknown>> {
      button('Giao bài').click();
      await settle();
      const request = http.expectOne(URL);
      const body = request.request.body;
      request.flush(assignment(), {
        status: 201,
        statusText: 'Created'
      });
      await settle();
      return body;
    }

    it('is offered only with the open stage lock', async () => {
      await show();
      expect(text()).not.toContain('Giới hạn số lần chơi mỗi màn');

      await pickLock('Mở tất cả');
      expect(text()).toContain('Giới hạn số lần chơi mỗi màn');
      expect(text()).toContain('Không giới hạn');
      expect(attemptsInput()).toBeNull();

      await pickLock('Phải qua màn trước');
      expect(text()).not.toContain('Giới hạn số lần chơi mỗi màn');
    });

    it('sends no limit by default, even with the open lock', async () => {
      await show();
      await pickLock('Mở tất cả');

      const body = await send();

      expect(body['stageLock']).toBe('open');
      expect(body['maxAttempts']).toBeNull();
    });

    it('shows a number box at 3 with its hint once switched on, and sends the number', async () => {
      await show();
      await pickLock('Mở tất cả');

      attemptsSwitch().click();
      await settle();

      expect(attemptsInput()!.value).toBe('3');
      expect(text()).toContain('Tối đa 3 lần mỗi màn.');
      await typeAttempts('5');
      expect(text()).toContain('Tối đa 5 lần');

      expect((await send())['maxAttempts']).toBe(5);
    });

    it('reads an emptied box as 3 and never sends a number outside 1 to 10', async () => {
      await show();
      await pickLock('Mở tất cả');
      attemptsSwitch().click();
      await settle();

      await typeAttempts('');
      expect(text()).toContain('Tối đa 3 lần');
      await typeAttempts('500');
      expect(text()).toContain('Tối đa 10 lần');
      await typeAttempts('0');
      expect(text()).toContain('Tối đa 1 lần');

      expect((await send())['maxAttempts']).toBe(1);
    });

    it('sends null after the lock goes back to sequential, whatever was set', async () => {
      await show();
      await pickLock('Mở tất cả');
      attemptsSwitch().click();
      await settle();
      await typeAttempts('2');

      await pickLock('Phải qua màn trước');

      const body = await send();
      expect(body['stageLock']).toBe('sequential');
      expect(body['maxAttempts']).toBeNull();
    });

    it('starts over when the dialog is opened again', async () => {
      await show();
      await pickLock('Mở tất cả');
      attemptsSwitch().click();
      await settle();
      await typeAttempts('2');

      fixture.componentInstance.open.set(false);
      await settle();
      fixture.componentInstance.open.set(true);
      await settle();

      expect(text()).not.toContain('Giới hạn số lần chơi mỗi màn');
      await pickLock('Mở tất cả');
      expect(attemptsInput()).toBeNull();
      expect((await send())['maxAttempts']).toBeNull();
    });

    it('tells the teacher when the server refuses the limit', async () => {
      await show();

      button('Giao bài').click();
      await settle();
      http.expectOne(URL).flush('Invalid replay limit.', {
        status: 400,
        statusText: 'Bad Request'
      });
      await settle();

      expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain('1–10');
    });
  });

  describe('the board for students', () => {
    const boardRow = (): HTMLElement => dialog()!.querySelector<HTMLElement>('[aria-labelledby="assign-show-board"]')!;
    const boardSwitch = (): HTMLButtonElement => boardRow().querySelector<HTMLButtonElement>('button[nz-switch], .ant-switch')!;

    async function send(): Promise<Record<string, unknown>> {
      button('Giao bài').click();
      await settle();
      const request = http.expectOne(URL);
      const body = request.request.body;
      request.flush(assignment(), {
        status: 201,
        statusText: 'Created'
      });
      await settle();
      return body;
    }

    it('is on by default, says what the students get and is sent as true', async () => {
      await show();

      expect(text()).toContain('Học sinh xem bảng xếp hạng');
      expect(boardSwitch().classList).toContain('ant-switch-checked');
      expect(boardRow().textContent).toContain('Top 5 của lớp và hạng của mình');

      expect((await send())['showBoard']).toBeTrue();
    });

    it('sends false once switched off, and says that only the teacher sees the board', async () => {
      await show();

      boardSwitch().click();
      await settle();

      expect(boardSwitch().classList).not.toContain('ant-switch-checked');
      expect(boardRow().textContent).toContain('Chỉ thầy cô xem bảng xếp hạng');
      expect((await send())['showBoard']).toBeFalse();
    });

    it('is on again when the dialog is opened again', async () => {
      await show();
      boardSwitch().click();
      await settle();

      fixture.componentInstance.open.set(false);
      await settle();
      fixture.componentInstance.open.set(true);
      await settle();

      expect(boardSwitch().classList).toContain('ant-switch-checked');
      expect((await send())['showBoard']).toBeTrue();
    });

    it('tells the teacher when the server refuses the setting', async () => {
      await show();

      button('Giao bài').click();
      await settle();
      http.expectOne(URL).flush('Invalid board setting.', {
        status: 400,
        statusText: 'Bad Request'
      });
      await settle();

      expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain('Cài đặt bảng xếp hạng');
    });
  });

  it('creates the assignment, then shows its link, QR code and the ways on', async () => {
    await show();
    await typeLabel('  Lớp 3A ');

    button('Giao bài').click();
    await settle();
    const request = http.expectOne(URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      jobId: 'job-1',
      label: 'Lớp 3A',
      closesAt: null,
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
    });
    expect(button('Giao bài').classList).toContain('ant-btn-loading');

    request.flush(assignment({ label: 'Lớp 3A' }), {
      status: 201,
      statusText: 'Created'
    });
    await settle();

    expect(text()).toContain('Đã giao bài.');
    expect(dialog()!.querySelector('app-share-link')).not.toBeNull();
    expect(dialog()!.querySelector('nz-qrcode')).not.toBeNull();
    expect(text()).toContain('K7M2X9QD4P');
    expect(dialog()!.querySelector('#assign-label')).toBeNull();
    expect(created.map(made => made.id)).toEqual(['asg-1']);

    button('Xem thử').click();
    expect(openWindow).toHaveBeenCalledWith('/play/preview/asg-1', '_blank', 'noopener');

    button('Xem bảng xếp hạng').click();
    await settle();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/assignments/asg-1');
    expect(fixture.componentInstance.open()).toBeFalse();
  });

  it('shows a refusal of the server in the dialog and lets the teacher try again', async () => {
    await show();

    button('Giao bài').click();
    await settle();
    http.expectOne(URL).flush('Too many assignments.', {
      status: 409,
      statusText: 'Conflict'
    });
    await settle();

    const alert = dialog()!.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Tối đa 100 bài');
    expect(created).toEqual([]);
    expect(button('Giao bài').disabled).toBeFalse();
  });

  it('opens a preview of the job itself from the form', async () => {
    await show();

    button('Xem thử').click();

    expect(openWindow).toHaveBeenCalledWith('/play/job-1', '_blank', 'noopener');
    http.expectNone(URL);
  });

  it('cannot give a job that holds no valid question', async () => {
    await show(job({ csv: 'Câu hỏi,Đáp án\nxin chào,你好' }));

    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain('không có câu hỏi hợp lệ');
    expect(button('Giao bài').disabled).toBeTrue();
    expect(button('Xem thử').disabled).toBeTrue();

    button('Giao bài').click();
    await settle();
    http.expectNone(URL);
  });

  it('starts over at the form each time it is opened', async () => {
    await show();
    await typeLabel('Lớp 3A');
    button('Giao bài').click();
    await settle();
    http.expectOne(URL).flush(assignment(), {
      status: 201,
      statusText: 'Created'
    });
    await settle();
    expect(text()).toContain('Đã giao bài.');

    fixture.componentInstance.open.set(false);
    await settle();
    fixture.componentInstance.open.set(true);
    await settle();

    expect(text()).not.toContain('Đã giao bài.');
    expect(dialog()!.querySelector<HTMLInputElement>('#assign-label')!.value).toBe('');
  });
});
