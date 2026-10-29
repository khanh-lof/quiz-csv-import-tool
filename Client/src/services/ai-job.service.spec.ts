import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AiJobService, NEW_JOB_IDLE_POLLS } from './ai-job.service';
import { AuthService } from './auth.service';
import { AiJob } from '../models/ai-job';

const URL = '/api/csv/jobs';
const POLL_MS = 3000;

function job(id: string, status: AiJob['status'], overrides: Partial<AiJob> = {}): AiJob {
  return {
    id,
    status,
    title: `Job ${id}`,
    creative: true,
    exportType: 0,
    intelligence: 1,
    imageCount: 0,
    courseType: null,
    courseName: '',
    hskStandard: null,
    level: null,
    lessonNumber: null,
    retryable: false,
    retryUntil: null,
    csv: '',
    errorStatus: 0,
    errorMessage: '',
    createdAt: '2026-10-13T00:00:00Z',
    finishedAt: null, ...overrides,
  };
}

describe('AiJobService', () => {
  let service: AiJobService;
  let http: HttpTestingController;
  let auth: AuthService;
  let notifications: jasmine.SpyObj<NzNotificationService>;

  beforeEach(() => {
    notifications = jasmine.createSpyObj('NzNotificationService', ['success', 'error']);
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), {
        provide: NzNotificationService,
        useValue: notifications
      }],
    });
    service = TestBed.inject(AiJobService);
    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  });

  afterEach(() => http.verify());

  function answer(...jobs: AiJob[]): void {
    http.expectOne(URL).flush({ jobs });
  }

  it('polls while a job runs, announces it finishing, then stops', fakeAsync(() => {
    service.watch();
    tick(0);
    answer(job('a', 'running'));
    expect(service.jobs().length).toBe(1);
    expect(service.loaded()).toBeTrue();
    expect(notifications.success).not.toHaveBeenCalled();

    tick(POLL_MS);
    answer(job('a', 'done', { csv: 'x,y' }));
    expect(notifications.success).toHaveBeenCalledTimes(1);
    expect(service.jobs()[0].status).toBe('done');

    tick(POLL_MS * 5); // nothing is running any more: no further request (http.verify would fail)
  }));

  it('does not announce jobs that were already finished when first seen', fakeAsync(() => {
    service.watch();
    tick(0);
    answer(job('old', 'done'), job('bad', 'failed', { errorStatus: 504 }));

    expect(notifications.success).not.toHaveBeenCalled();
    expect(notifications.error).not.toHaveBeenCalled();
  }));

  it('explains a failed job once, with the reason', fakeAsync(() => {
    service.watch();
    tick(0);
    answer(job('a', 'running'));
    tick(POLL_MS);
    answer(job('a', 'failed', {
      errorStatus: 504,
      errorMessage: 'AI generation timed out.'
    }));

    expect(notifications.error).toHaveBeenCalledTimes(1);
    expect(notifications.error.calls.mostRecent().args[1]).toContain('Quá lâu');
  }));

  it('keeps polling for the requested idle rounds after a submit', fakeAsync(() => {
    service.watch(3);
    tick(0);
    answer(); // the new job is not visible yet
    tick(POLL_MS);
    answer(job('new', 'running'));
    tick(POLL_MS);
    answer(job('new', 'done'));
    tick(POLL_MS);
    answer(job('new', 'done'));
    tick(POLL_MS);
    answer(job('new', 'done')); // third idle answer in a row: stops
    tick(POLL_MS * 5);
    expect(service.jobs()[0].status).toBe('done');
  }));

  it('does not start a second poller while one runs', fakeAsync(() => {
    service.watch();
    service.watch();
    tick(0);
    answer(job('a', 'running'));
    tick(POLL_MS);
    answer(job('a', 'done'));
    tick(POLL_MS);
    expect(service.jobs()[0].status).toBe('done');
  }));

  it('survives a failed poll and keeps going', fakeAsync(() => {
    service.watch();
    tick(0);
    http.expectOne(URL).flush('', {
      status: 500,
      statusText: 'Error'
    });
    tick(POLL_MS);
    answer(job('a', 'running'));
    tick(POLL_MS);
    answer(job('a', 'done'));
    tick(POLL_MS);
    expect(service.jobs()[0].status).toBe('done');
  }));

  it('forgets the jobs when the session ends', fakeAsync(() => {
    service.watch();
    tick(0);
    answer(job('a', 'running'));
    auth.clear();

    expect(service.jobs()).toEqual([]);
    expect(service.loaded()).toBeFalse();
    tick(POLL_MS * 3); // polling was stopped too
  }));

  it('removes a job from the list once the server deleted it, or reports it already gone', () => {
    service.refresh().subscribe();
    answer(job('a', 'done'), job('b', 'done'));

    service.remove('a').subscribe();
    http.expectOne(`${URL}/a`).flush(null, {
      status: 204,
      statusText: 'No Content'
    });
    expect(service.jobs().map(j => j.id)).toEqual(['b']);

    let failed = false;
    service.remove('b').subscribe({ error: () => failed = true });
    http.expectOne(`${URL}/b`).flush('Job not found', {
      status: 404,
      statusText: 'Not Found'
    });
    expect(service.jobs()).toEqual([]);
    expect(failed).toBeFalse();
  });

  it('keeps the job when the delete fails', () => {
    service.refresh().subscribe();
    answer(job('a', 'done'));

    let failed = false;
    service.remove('a').subscribe({ error: () => failed = true });
    http.expectOne(`${URL}/a`).flush('', {
      status: 500,
      statusText: 'Error'
    });

    expect(failed).toBeTrue();
    expect(service.jobs().length).toBe(1);
  });

  describe('retry', () => {
    // Runs out the polling a retry starts, with no job running any more.
    function pollUntilIdle(...jobs: AiJob[]): void {
      for (let i = 0; i < NEW_JOB_IDLE_POLLS; i++) {
        tick(i === 0 ? 0 : POLL_MS);
        answer(...jobs);
      }
      tick(POLL_MS * 3);
    }

    it('asks the server to send a failed job again, which replaces it', fakeAsync(() => {
      service.refresh().subscribe();
      answer(job('a', 'failed', { retryable: true }), job('c', 'done'));

      let submitted: string | undefined;
      service.retry(service.jobs()[0]).subscribe(created => submitted = created.id);
      const retry = http.expectOne(`${URL}/a/retry`);
      expect(retry.request.method).toBe('POST');
      retry.flush({ id: 'b' });

      expect(submitted).toBe('b');
      // The server deleted the failed job; the new one shows up with the next poll.
      expect(service.jobs().map(j => j.id)).toEqual(['c']);
      pollUntilIdle(job('b', 'done'), job('c', 'done'));
      expect(service.jobs().map(j => j.id)).toEqual(['b', 'c']);
    }));

    it('keeps the failed job when the server refuses', () => {
      service.refresh().subscribe();
      answer(job('a', 'failed', { retryable: true, imageCount: 1, retryUntil: '2026-10-13T01:00:00Z' }));

      let status: number | undefined;
      service.retry(service.jobs()[0]).subscribe({ error: err => status = err.status });
      http.expectOne(`${URL}/a/retry`).flush('Images expired.', {
        status: 410,
        statusText: 'Gone'
      });

      expect(status).toBe(410);
      expect(service.jobs().map(j => j.id)).toEqual(['a']);
    });

    it('only retries a failed job the server would take, until its images expire', () => {
      const now = Date.parse('2026-10-13T10:00:00Z');
      expect(service.canRetry(job('a', 'failed', { retryable: true }), now)).toBeTrue();
      expect(service.canRetry(job('a', 'failed'), now)).toBeFalse();
      expect(service.canRetry(job('a', 'done', { retryable: true }), now)).toBeFalse();

      const withImages = job('a', 'failed', { retryable: true, imageCount: 2, retryUntil: '2026-10-13T10:30:00Z' });
      expect(service.canRetry(withImages, now)).toBeTrue();
      // The list is only as fresh as the last poll.
      expect(service.canRetry(withImages, Date.parse('2026-10-13T10:30:00Z'))).toBeFalse();
    });
  });
});
