import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Assignment, AssignmentDetail, NewAssignment } from '../models/assignment';
import { AssignmentService } from './assignment.service';

const URL = '/api/assignments';

function assignment(id: string, overrides: Partial<Assignment> = {}): Assignment {
  return {
    id,
    code: 'K7M2X9QD4P',
    jobId: 'job-1',
    title: 'HSK1 bài 1',
    label: '',
    timeMode: 'standard',
    stageLock: 'sequential',
    passPercents: { '1': 70 },
    maxAttempts: null,
    showBoard: true,
    stageCounts: { '1': 5 },
    timeLimits: { '1': 12 },
    createdAt: '2026-10-14T01:00:00Z',
    closesAt: null,
    closedAt: null,
    open: true,
    playerCount: 0, ...overrides,
  };
}

describe('AssignmentService', () => {
  let service: AssignmentService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(AssignmentService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('creates an assignment with a POST of the request', () => {
    const request: NewAssignment = {
      jobId: 'job-1',
      label: '6A',
      closesAt: '2026-10-14T03:00:00Z',
      timeMode: 'extra',
      stageLock: 'open',
      passPercents: {
        '1': 70,
        '2': 70
      },
      maxAttempts: null,
      showBoard: true,
    };
    let created: Assignment | undefined;
    service.create(request).subscribe(a => created = a);

    const req = http.expectOne(URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(request);
    req.flush(assignment('a1'), {
      status: 201,
      statusText: 'Created'
    });
    expect(created?.id).toBe('a1');
  });

  it('lists the assignments from the body', () => {
    let result: Assignment[] = [];
    service.list().subscribe(list => result = list);

    const req = http.expectOne(URL);
    expect(req.request.method).toBe('GET');
    req.flush({ assignments: [assignment('b'), assignment('a')] });
    expect(result.map(a => a.id)).toEqual(['b', 'a']);
  });

  it('gets one assignment with its leaderboard', () => {
    let detail: AssignmentDetail | undefined;
    service.get('a1').subscribe(d => detail = d);

    const req = http.expectOne(`${URL}/a1`);
    expect(req.request.method).toBe('GET');
    req.flush({
      ...assignment('a1'),
      csv: '1,Q,Đúng,,,,',
      players: []
    });
    expect(detail?.csv).toBe('1,Q,Đúng,,,,');
  });

  it('patches only the keys of the change', () => {
    service.update('a1', { closed: true }).subscribe();

    const req = http.expectOne(`${URL}/a1`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ closed: true });
    req.flush(assignment('a1', {
      closedAt: '2026-10-14T02:00:00Z',
      open: false
    }));
  });

  it('can send a null closing time to remove it', () => {
    service.update('a1', { closesAt: null }).subscribe();

    const req = http.expectOne(`${URL}/a1`);
    expect(req.request.body).toEqual({ closesAt: null });
    req.flush(assignment('a1'));
  });

  it('deletes an assignment', () => {
    let done = false;
    service.remove('a1').subscribe(() => done = true);

    const req = http.expectOne(`${URL}/a1`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null, {
      status: 204,
      statusText: 'No Content'
    });
    expect(done).toBeTrue();
  });

  it('counts an assignment that is already gone as deleted', () => {
    let done = false;
    service.remove('a1').subscribe(() => done = true);

    http.expectOne(`${URL}/a1`).flush('Assignment not found', {
      status: 404,
      statusText: 'Not Found'
    });
    expect(done).toBeTrue();
  });

  it('reports other failures of a delete', () => {
    let error: HttpErrorResponse | undefined;
    service.remove('a1').subscribe({ error: e => error = e });

    http.expectOne(`${URL}/a1`).flush('boom', {
      status: 500,
      statusText: 'Server Error'
    });
    expect(error?.status).toBe(500);
  });

  it('removes a student', () => {
    let done = false;
    service.removePlayer('a1', 'p9').subscribe(() => done = true);

    const req = http.expectOne(`${URL}/a1/players/p9`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null, {
      status: 204,
      statusText: 'No Content'
    });
    expect(done).toBeTrue();
  });

  it('counts a student who is already gone as removed', () => {
    let done = false;
    service.removePlayer('a1', 'p9').subscribe(() => done = true);

    http.expectOne(`${URL}/a1/players/p9`).flush('Player not found', {
      status: 404,
      statusText: 'Not Found'
    });
    expect(done).toBeTrue();
  });

  it('reports other failures of removing a student', () => {
    let error: HttpErrorResponse | undefined;
    service.removePlayer('a1', 'p9').subscribe({ error: e => error = e });

    http.expectOne(`${URL}/a1/players/p9`).flush('no', {
      status: 403,
      statusText: 'Forbidden'
    });
    expect(error?.status).toBe(403);
  });
});
