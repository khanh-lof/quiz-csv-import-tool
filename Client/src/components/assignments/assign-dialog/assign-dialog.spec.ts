import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AiJob } from '../../../models/ai-job';
import { Assignment } from '../../../models/assignment';
import { DEMO_QUIZ_CSV } from '../../../game/demo-quiz';
import { AssignDialog } from './assign-dialog';

const URL = '/api/assignments';

function job(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: 'job-1', status: 'done', title: 'Quiz HSK 1 bài 3', creative: true, exportType: 3, intelligence: 1,
    imageCount: 0, courseType: null, courseName: '', hskStandard: null, level: null, lessonNumber: null,
    csv: DEMO_QUIZ_CSV, errorStatus: 0, errorMessage: '', createdAt: '2026-10-13T00:00:00Z',
    finishedAt: '2026-10-13T00:01:00Z', ...overrides,
  };
}

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: 'asg-1', code: 'K7M2X9QD4P', jobId: 'job-1', title: 'Quiz HSK 1 bài 3', label: '', timeMode: 'standard',
    stageCounts: {'1': 5, '2': 5, '3': 5, '4': 5, '5': 5, '6': 5}, createdAt: '2026-10-14T00:00:00Z', closesAt: null,
    closedAt: null, open: true, playerCount: 0, ...overrides,
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
        {provide: NzNotificationService, useValue: notifications},
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
      stageCounts: {'1': 5, '2': 5, '3': 5, '4': 5, '5': 5, '6': 5},
    });
    expect(button('Giao bài').classList).toContain('ant-btn-loading');

    request.flush(assignment({label: 'Lớp 3A'}), {status: 201, statusText: 'Created'});
    await settle();

    expect(text()).toContain('Đã giao bài!');
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
    http.expectOne(URL).flush('Too many assignments.', {status: 409, statusText: 'Conflict'});
    await settle();

    const alert = dialog()!.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('100 bài giao');
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
    await show(job({csv: 'Câu hỏi,Đáp án\nxin chào,你好'}));

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
    http.expectOne(URL).flush(assignment(), {status: 201, statusText: 'Created'});
    await settle();
    expect(text()).toContain('Đã giao bài!');

    fixture.componentInstance.open.set(false);
    await settle();
    fixture.componentInstance.open.set(true);
    await settle();

    expect(text()).not.toContain('Đã giao bài!');
    expect(dialog()!.querySelector<HTMLInputElement>('#assign-label')!.value).toBe('');
  });
});
