import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { PlayerIdentity, StudentBoard, SubmitOutcome } from '../models/assignment';
import { SharedPlayService } from './shared-play.service';

const IDENTITY_KEY = 'gesture-shared-players';
const PENDING_KEY = 'gesture-shared-pending';
const CODE = 'K7M2X9QD4P';
const RESULTS_URL = `/api/share/${CODE}/results`;

const LAN: PlayerIdentity = {playerId: 'p1', token: 'tok-lan', name: 'Lan', avatar: 'cat'};

function storedPending(): { code: string; token: string; runId: string; stage: number; correct: number; total: number }[] {
  return JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]');
}

describe('SharedPlayService', () => {
  let service: SharedPlayService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.removeItem(IDENTITY_KEY);
    localStorage.removeItem(PENDING_KEY);
    TestBed.configureTestingModule({providers: [provideHttpClient(), provideHttpClientTesting()]});
    service = TestBed.inject(SharedPlayService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    localStorage.removeItem(IDENTITY_KEY);
    localStorage.removeItem(PENDING_KEY);
  });

  // Gives this device an identity for CODE without going through a join.
  function joined(identity: PlayerIdentity = LAN): void {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({[CODE]: identity}));
  }

  function submitStage(stage = 1, correct = 4, total = 5): SubmitOutcome[] {
    const outcomes: SubmitOutcome[] = [];
    service.submit(CODE, {stage, correct, total}).subscribe(outcome => outcomes.push(outcome));
    return outcomes;
  }

  function answerResult(status: number): TestRequest {
    const req = http.expectOne(RESULTS_URL);
    if (status >= 200 && status < 300) {
      req.flush(null, {status, statusText: 'OK'});
    } else {
      req.flush('no', {status, statusText: 'Error'});
    }
    return req;
  }

  function failResult(): void {
    http.expectOne(RESULTS_URL).error(new ProgressEvent('error'), {status: 0});
  }

  describe('load', () => {
    it('gets the shared quiz by its code', () => {
      let title = '';
      service.load(CODE).subscribe(quiz => title = quiz.title);

      const req = http.expectOne(`/api/share/${CODE}`);
      expect(req.request.method).toBe('GET');
      req.flush({title: 'HSK1 bài 1', label: '6A', csv: '', timeMode: 'standard', stageLock: 'sequential', passPercents: {'1': 70}, maxAttempts: null, showBoard: true, attempts: {}, closesAt: null});
      expect(title).toBe('HSK1 bài 1');
    });

    it('sends no player header from a device that has not joined', () => {
      service.load(CODE).subscribe();

      const req = http.expectOne(`/api/share/${CODE}`);
      expect(req.request.headers.has('X-Player-Token')).toBeFalse();
      req.flush({});
    });

    it('sends the stored token, so the answer holds the attempts of this student', () => {
      joined();
      let attempts: Record<string, number> = {};
      service.load(CODE.toLowerCase()).subscribe(quiz => attempts = quiz.attempts);

      const req = http.expectOne(`/api/share/${CODE.toLowerCase()}`);
      expect(req.request.headers.get('X-Player-Token')).toBe('tok-lan');
      req.flush({title: 'HSK1 bài 1', maxAttempts: 3, attempts: {'1': 2, '4': 1}});
      expect(attempts).toEqual({'1': 2, '4': 1});
    });

    it('sends no header again once the device forgot the student', () => {
      joined();
      service.forget(CODE);
      service.load(CODE).subscribe();

      const req = http.expectOne(`/api/share/${CODE}`);
      expect(req.request.headers.has('X-Player-Token')).toBeFalse();
      req.flush({});
    });

    it('escapes the code in the URL', () => {
      service.load('a/b c').subscribe();

      const req = http.expectOne('/api/share/a%2Fb%20c');
      expect(req.request.url).toBe('/api/share/a%2Fb%20c');
      req.flush({});
    });

    it('leaves a 404 and a 410 for the page to read', () => {
      const statuses: number[] = [];
      for (const status of [404, 410]) {
        service.load(CODE).subscribe({error: (e: HttpErrorResponse) => statuses.push(e.status)});
        http.expectOne(`/api/share/${CODE}`).flush('x', {status, statusText: 'x'});
      }
      expect(statuses).toEqual([404, 410]);
    });
  });

  describe('join and identity', () => {
    it('posts the name and the avatar, returns the identity and remembers it on the device', () => {
      let identity: PlayerIdentity | undefined;
      service.join(CODE, 'Lan', 'cat').subscribe(i => identity = i);

      const req = http.expectOne(`/api/share/${CODE}/players`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({name: 'Lan', avatar: 'cat'});
      req.flush(LAN, {status: 201, statusText: 'Created'});

      expect(identity).toEqual(LAN);
      expect(service.identity(CODE)).toEqual(LAN);
      expect(JSON.parse(localStorage.getItem(IDENTITY_KEY)!)).toEqual({[CODE]: LAN});
    });

    it('sends an empty avatar when none is given, and stores what the server answers', () => {
      let identity: PlayerIdentity | undefined;
      service.join(CODE, 'Lan').subscribe(i => identity = i);

      const req = http.expectOne(`/api/share/${CODE}/players`);
      expect(req.request.body).toEqual({name: 'Lan', avatar: ''});
      req.flush({...LAN, avatar: ''}, {status: 201, statusText: 'Created'});

      expect(identity?.avatar).toBe('');
      expect(service.identity(CODE)?.avatar).toBe('');
    });

    it('reads an answer without an avatar (an older server) as no avatar', () => {
      let identity: PlayerIdentity | undefined;
      service.join(CODE, 'Lan', 'cat').subscribe(i => identity = i);

      http.expectOne(`/api/share/${CODE}/players`).flush({playerId: 'p1', token: 'tok-lan', name: 'Lan'});

      expect(identity).toEqual({...LAN, avatar: ''});
      expect(service.identity(CODE)).toEqual({...LAN, avatar: ''});
    });

    it('rethrows the failures with their status and body', () => {
      const errors: HttpErrorResponse[] = [];
      for (const [status, body] of [[409, 'Name taken'], [409, 'Assignment is full'], [410, 'Assignment closed'],
        [404, 'Assignment not found'], [400, 'Invalid name.'], [400, 'Invalid avatar.']] as const) {
        service.join(CODE, 'Lan').subscribe({error: (e: HttpErrorResponse) => errors.push(e)});
        http.expectOne(`/api/share/${CODE}/players`).flush(body, {status, statusText: 'x'});
      }
      expect(errors.map(e => [e.status, e.error])).toEqual([
        [409, 'Name taken'], [409, 'Assignment is full'], [410, 'Assignment closed'],
        [404, 'Assignment not found'], [400, 'Invalid name.'], [400, 'Invalid avatar.'],
      ]);
      expect(service.identity(CODE)).toBeNull();
    });

    it('finds the identity whatever the case of the code, and keeps one per code', () => {
      service.join('k7m2x9qd4p', 'Lan').subscribe();
      http.expectOne('/api/share/k7m2x9qd4p/players').flush(LAN);
      service.join('ABCDEFGHJK', 'Minh').subscribe();
      http.expectOne('/api/share/ABCDEFGHJK/players').flush({playerId: 'p2', token: 'tok-minh', name: 'Minh'});

      expect(service.identity(CODE)).toEqual(LAN);
      expect(service.identity('abcdefghjk')?.name).toBe('Minh');
      expect(service.identity('ZZZZZZZZZZ')).toBeNull();
    });

    it('forgets only the identity of that code', () => {
      localStorage.setItem(IDENTITY_KEY, JSON.stringify({[CODE]: LAN, OTHER00000: {playerId: 'p2', token: 't', name: 'Minh'}}));

      service.forget(CODE.toLowerCase());

      expect(service.identity(CODE)).toBeNull();
      expect(service.identity('OTHER00000')?.name).toBe('Minh');
      expect(Object.keys(JSON.parse(localStorage.getItem(IDENTITY_KEY)!))).toEqual(['OTHER00000']);
    });

    it('reads an identity stored before avatars existed as one with no avatar', () => {
      localStorage.setItem(IDENTITY_KEY, JSON.stringify({
        [CODE]: {playerId: 'p1', token: 'tok-lan', name: 'Lan'},
        OTHER00000: {playerId: 'p2', token: 'tok-minh', name: 'Minh', avatar: 42},
      }));

      expect(service.identity(CODE)).toEqual({playerId: 'p1', token: 'tok-lan', name: 'Lan', avatar: ''});
      expect(service.identity('OTHER00000')?.avatar).toBe('');
    });

    it('drops stored entries that are not identities', () => {
      localStorage.setItem(IDENTITY_KEY, JSON.stringify({
        [CODE]: LAN, A: {playerId: 1, token: 't', name: 'x'}, B: null, C: {playerId: 'p', token: '', name: 'x'}, D: 'str',
      }));

      expect(service.identity(CODE)).toEqual(LAN);
      expect(service.identity('A')).toBeNull();
      expect(service.identity('B')).toBeNull();
      expect(service.identity('C')).toBeNull();
      expect(service.identity('D')).toBeNull();
    });

    it('reads anything that is not an object, or not JSON, as no identity', () => {
      for (const raw of ['[1,2]', '"x"', 'null', '{broken']) {
        localStorage.setItem(IDENTITY_KEY, raw);
        expect(service.identity(CODE)).toBeNull();
      }
    });

    it('still remembers the identity for the session when the storage is blocked', () => {
      spyOn(Storage.prototype, 'getItem').and.throwError('blocked');
      spyOn(Storage.prototype, 'setItem').and.throwError('blocked');

      service.join(CODE, 'Lan').subscribe();
      http.expectOne(`/api/share/${CODE}/players`).flush(LAN);

      expect(service.identity(CODE)).toEqual(LAN);
      service.forget(CODE);
      expect(service.identity(CODE)).toBeNull();
    });
  });

  describe('setAvatar', () => {
    const PLAYER_URL = `/api/share/${CODE}/player`;

    function change(avatar = 'dragon'): { identities: PlayerIdentity[]; errors: HttpErrorResponse[] } {
      const result = {identities: [] as PlayerIdentity[], errors: [] as HttpErrorResponse[]};
      service.setAvatar(CODE, avatar).subscribe({
        next: identity => result.identities.push(identity),
        error: (e: HttpErrorResponse) => result.errors.push(e),
      });
      return result;
    }

    it('patches the avatar with the token in a header', () => {
      joined();
      change('dragon');

      const req = http.expectOne(PLAYER_URL);
      expect(req.request.method).toBe('PATCH');
      expect(req.request.headers.get('X-Player-Token')).toBe('tok-lan');
      expect(req.request.body).toEqual({avatar: 'dragon'});
      req.flush({playerId: 'p1', name: 'Lan', avatar: 'dragon'});
    });

    it('emits the identity with the new avatar and stores it on the device', () => {
      joined();
      const result = change('dragon');

      http.expectOne(PLAYER_URL).flush({playerId: 'p1', name: 'Lan', avatar: 'dragon'});

      const updated: PlayerIdentity = {...LAN, avatar: 'dragon'};
      expect(result.identities).toEqual([updated]);
      expect(result.errors).toEqual([]);
      expect(service.identity(CODE)).toEqual(updated);
      expect(JSON.parse(localStorage.getItem(IDENTITY_KEY)!)).toEqual({[CODE]: updated});
    });

    it('finds the identity whatever the case of the code, and leaves the other codes alone', () => {
      localStorage.setItem(IDENTITY_KEY, JSON.stringify({[CODE]: LAN, OTHER00000: {playerId: 'p2', token: 't2', name: 'Minh', avatar: 'owl'}}));

      service.setAvatar(CODE.toLowerCase(), 'fox').subscribe();
      http.expectOne(`/api/share/${CODE.toLowerCase()}/player`).flush({playerId: 'p1', name: 'Lan', avatar: 'fox'});

      expect(service.identity(CODE)?.avatar).toBe('fox');
      expect(service.identity('OTHER00000')?.avatar).toBe('owl');
    });

    it('fails with a 403 and sends nothing when this device has not joined', () => {
      const result = change();

      http.expectNone(PLAYER_URL);
      expect(result.identities).toEqual([]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0] instanceof HttpErrorResponse).toBeTrue();
      expect(result.errors[0].status).toBe(403);
    });

    it('forgets the identity on a 403 (the teacher removed the student) and rethrows it', () => {
      joined();
      const result = change();

      http.expectOne(PLAYER_URL).flush('Unknown player', {status: 403, statusText: 'Forbidden'});

      expect(result.identities).toEqual([]);
      expect(result.errors.map(e => [e.status, e.error])).toEqual([[403, 'Unknown player']]);
      expect(service.identity(CODE)).toBeNull();
    });

    it('rethrows every other failure unchanged and keeps the identity', () => {
      joined();
      for (const [status, body] of [[400, 'Invalid avatar.'], [404, 'Assignment not found'], [410, 'Assignment closed'],
        [500, 'boom']] as const) {
        const result = change();
        http.expectOne(PLAYER_URL).flush(body, {status, statusText: 'x'});
        expect(result.errors.map(e => [e.status, e.error])).toEqual([[status, body]]);
      }
      expect(service.identity(CODE)).toEqual(LAN);
    });

    it('rethrows a lost connection and keeps the identity', () => {
      joined();
      const result = change();

      http.expectOne(PLAYER_URL).error(new ProgressEvent('error'), {status: 0});

      expect(result.errors.map(e => e.status)).toEqual([0]);
      expect(service.identity(CODE)).toEqual(LAN);
    });

    it('does not touch another student the device switched to while the request was out', () => {
      joined();
      const result = change('dragon');
      const nam: PlayerIdentity = {playerId: 'p2', token: 'tok-nam', name: 'Nam', avatar: 'owl'};
      joined(nam);

      http.expectOne(PLAYER_URL).flush({playerId: 'p1', name: 'Lan', avatar: 'dragon'});

      expect(result.identities).toEqual([{...LAN, avatar: 'dragon'}]);
      expect(service.identity(CODE)).toEqual(nam);
    });

    it('keeps the new avatar for the session when the storage is blocked', () => {
      joined();
      expect(service.identity(CODE)).toEqual(LAN); // read once while the storage still works
      spyOn(Storage.prototype, 'getItem').and.throwError('blocked');
      spyOn(Storage.prototype, 'setItem').and.throwError('blocked');

      change('dragon');
      http.expectOne(PLAYER_URL).flush({playerId: 'p1', name: 'Lan', avatar: 'dragon'});

      expect(service.identity(CODE)?.avatar).toBe('dragon');
    });
  });

  describe('leaderboard', () => {
    const BOARD: StudentBoard = {
      top: [{rank: 1, name: 'Lan', avatar: 'cat', stagesPassed: 2, correct: 9, you: true}],
      you: {rank: 1, name: 'Lan', avatar: 'cat', stagesPassed: 2, correct: 9},
      possible: 10, stageCount: 2, playerCount: 3,
    };

    it('gets the board of the code and returns it', () => {
      let board: StudentBoard | undefined;
      service.leaderboard(CODE).subscribe(b => board = b);

      const req = http.expectOne(`/api/share/${CODE}/leaderboard`);
      expect(req.request.method).toBe('GET');
      req.flush(BOARD);
      expect(board).toEqual(BOARD);
    });

    it('sends no player header from a device that has not joined', () => {
      service.leaderboard(CODE).subscribe();

      const req = http.expectOne(`/api/share/${CODE}/leaderboard`);
      expect(req.request.headers.has('X-Player-Token')).toBeFalse();
      req.flush({...BOARD, you: null});
    });

    it('sends the stored token so the answer holds the student\'s own row', () => {
      joined();
      service.leaderboard(CODE.toLowerCase()).subscribe();

      const req = http.expectOne(`/api/share/${CODE.toLowerCase()}/leaderboard`);
      expect(req.request.headers.get('X-Player-Token')).toBe('tok-lan');
      req.flush(BOARD);
    });

    it('sends no header again once the device forgot the student', () => {
      joined();
      service.forget(CODE);
      service.leaderboard(CODE).subscribe();

      const req = http.expectOne(`/api/share/${CODE}/leaderboard`);
      expect(req.request.headers.has('X-Player-Token')).toBeFalse();
      req.flush(BOARD);
    });

    it('escapes the code in the URL', () => {
      service.leaderboard('a/b c').subscribe();

      const req = http.expectOne('/api/share/a%2Fb%20c/leaderboard');
      expect(req.request.url).toBe('/api/share/a%2Fb%20c/leaderboard');
      req.flush(BOARD);
    });

    it('leaves a 404 for the caller to read', () => {
      const statuses: number[] = [];
      service.leaderboard(CODE).subscribe({error: (e: HttpErrorResponse) => statuses.push(e.status)});

      http.expectOne(`/api/share/${CODE}/leaderboard`).flush('Assignment not found', {status: 404, statusText: 'Not Found'});

      expect(statuses).toEqual([404]);
    });
  });

  describe('submit', () => {
    it('is rejected without a request when this device has not joined', () => {
      expect(submitStage()).toEqual(['rejected']);
      http.expectNone(RESULTS_URL);
    });

    it('posts the run with the token in a header and a fresh runId, and says saved', () => {
      joined();
      const outcomes = submitStage(2, 4, 5);

      const req = http.expectOne(RESULTS_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('X-Player-Token')).toBe('tok-lan');
      expect(req.request.body.stage).toBe(2);
      expect(req.request.body.correct).toBe(4);
      expect(req.request.body.total).toBe(5);
      expect(req.request.body.runId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
      expect(Object.keys(req.request.body).sort()).toEqual(['correct', 'runId', 'stage', 'total']);
      req.flush(null, {status: 204, statusText: 'No Content'});

      expect(outcomes).toEqual(['saved']);
      expect(service.pendingCount(CODE)).toBe(0);
    });

    it('gives every run its own runId', () => {
      joined();
      submitStage(1);
      const first = http.expectOne(RESULTS_URL);
      first.flush(null, {status: 204, statusText: 'No Content'});
      submitStage(1);
      const second = http.expectOne(RESULTS_URL);
      second.flush(null, {status: 204, statusText: 'No Content'});

      expect(first.request.body.runId).not.toBe(second.request.body.runId);
    });

    it('makes a valid runId where randomUUID does not exist (plain http)', () => {
      joined();
      Object.defineProperty(crypto, 'randomUUID', {value: undefined, configurable: true});
      try {
        submitStage();
      } finally {
        delete (crypto as { randomUUID?: unknown }).randomUUID;
      }

      const req = http.expectOne(RESULTS_URL);
      expect(req.request.body.runId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
      req.flush(null, {status: 204, statusText: 'No Content'});
    });

    it('queues the run on the device when the server cannot be reached', () => {
      joined();
      const outcomes = submitStage(3, 7, 10);
      failResult();

      expect(outcomes).toEqual(['queued']);
      expect(service.pendingCount(CODE)).toBe(1);
      const [entry] = storedPending();
      expect(entry).toEqual(jasmine.objectContaining({code: CODE, token: 'tok-lan', stage: 3, correct: 7, total: 10}));
      expect(entry.runId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    });

    it('queues the run on a server error', () => {
      joined();
      for (const status of [500, 502, 503, 504]) {
        const outcomes = submitStage();
        answerResult(status);
        expect(outcomes).toEqual(['queued']);
      }
      expect(service.pendingCount(CODE)).toBe(4);
    });

    it('does not retry a failed send by itself', () => {
      joined();
      submitStage();
      failResult();

      http.expectNone(RESULTS_URL);
      expect(service.pendingCount(CODE)).toBe(1);
    });

    it('says closed on a 410 and does not queue the run', () => {
      joined();
      const outcomes = submitStage();
      answerResult(410);

      expect(outcomes).toEqual(['closed']);
      expect(service.pendingCount(CODE)).toBe(0);
      expect(service.identity(CODE)).toEqual(LAN);
    });

    it('says limit on a 409, without queueing the run or forgetting the student', () => {
      joined();
      const outcomes = submitStage();
      http.expectOne(RESULTS_URL).flush('Replay limit reached', {status: 409, statusText: 'Conflict'});

      expect(outcomes).toEqual(['limit']);
      expect(service.pendingCount(CODE)).toBe(0);
      expect(service.identity(CODE)).toEqual(LAN);
    });

    it('forgets the identity on a 403 and says rejected', () => {
      joined();
      const outcomes = submitStage();
      answerResult(403);

      expect(outcomes).toEqual(['rejected']);
      expect(service.identity(CODE)).toBeNull();
      expect(service.pendingCount(CODE)).toBe(0);
    });

    it('says rejected on other client errors, without queueing or forgetting', () => {
      joined();
      for (const status of [400, 404, 422]) {
        const outcomes = submitStage();
        answerResult(status);
        expect(outcomes).toEqual(['rejected']);
      }
      expect(service.pendingCount(CODE)).toBe(0);
      expect(service.identity(CODE)).toEqual(LAN);
    });

    it('starts sending what was queued once a run is saved', () => {
      joined();
      localStorage.setItem(PENDING_KEY, JSON.stringify([
        {code: CODE, token: 'tok-lan', runId: 'old-run-0001', stage: 1, correct: 5, total: 5},
      ]));

      const outcomes = submitStage(2);
      const fresh = http.expectOne(RESULTS_URL);
      fresh.flush(null, {status: 204, statusText: 'No Content'});
      expect(outcomes).toEqual(['saved']);

      const old = http.expectOne(RESULTS_URL);
      expect(old.request.body.runId).toBe('old-run-0001');
      old.flush(null, {status: 204, statusText: 'No Content'});
      expect(service.pendingCount(CODE)).toBe(0);
    });

    it('does not flush after a run that was only queued', () => {
      joined();
      submitStage();
      failResult();

      http.expectNone(RESULTS_URL);
      expect(service.pendingCount(CODE)).toBe(1);
    });
  });

  describe('flush', () => {
    function queue(...entries: Partial<ReturnType<typeof storedPending>[number]>[]): void {
      localStorage.setItem(PENDING_KEY, JSON.stringify(entries.map((entry, i) => ({
        code: CODE, token: 'tok-lan', runId: `run-0000${i}`, stage: i + 1, correct: 4, total: 5, ...entry,
      }))));
    }

    it('sends the queue in order, each run with its own token and runId, and empties it', () => {
      queue({token: 'tok-a'}, {token: 'tok-b'}, {token: 'tok-c'});
      let done = false;
      service.flush(CODE).subscribe(() => done = true);

      for (const [i, token] of ['tok-a', 'tok-b', 'tok-c'].entries()) {
        const req = http.expectOne(RESULTS_URL);
        expect(req.request.headers.get('X-Player-Token')).toBe(token);
        expect(req.request.body).toEqual({runId: `run-0000${i}`, stage: i + 1, correct: 4, total: 5});
        req.flush(null, {status: 204, statusText: 'No Content'});
      }

      expect(done).toBeTrue();
      expect(service.pendingCount(CODE)).toBe(0);
      expect(storedPending()).toEqual([]);
    });

    it('does nothing, and still completes, when nothing is queued', () => {
      let done = false;
      service.flush(CODE).subscribe(() => done = true);

      expect(done).toBeTrue();
    });

    it('stops at the first run the server cannot take and keeps it and the rest', () => {
      queue({}, {}, {});
      let done = false;
      service.flush(CODE).subscribe(() => done = true);

      http.expectOne(RESULTS_URL).flush(null, {status: 204, statusText: 'No Content'});
      http.expectOne(RESULTS_URL).flush('down', {status: 503, statusText: 'Unavailable'});

      http.expectNone(RESULTS_URL);
      expect(done).toBeTrue();
      expect(storedPending().map(entry => entry.runId)).toEqual(['run-00001', 'run-00002']);
    });

    it('stops on a lost connection too', () => {
      queue({}, {});
      service.flush(CODE).subscribe();

      failResult();

      http.expectNone(RESULTS_URL);
      expect(service.pendingCount(CODE)).toBe(2);
    });

    it('drops a run the server refuses for good and goes on with the next', () => {
      queue({}, {}, {});
      service.flush(CODE).subscribe();

      http.expectOne(RESULTS_URL).flush('closed', {status: 410, statusText: 'Gone'});
      http.expectOne(RESULTS_URL).flush('bad', {status: 400, statusText: 'Bad Request'});
      http.expectOne(RESULTS_URL).flush('who', {status: 403, statusText: 'Forbidden'});

      expect(service.pendingCount(CODE)).toBe(0);
    });

    it('sends only the runs of that code', () => {
      queue({}, {code: 'OTHER00000', token: 'tok-other'}, {});
      service.flush(CODE.toLowerCase()).subscribe();

      http.expectOne(RESULTS_URL).flush(null, {status: 204, statusText: 'No Content'});
      http.expectOne(RESULTS_URL).flush(null, {status: 204, statusText: 'No Content'});

      http.expectNone('/api/share/OTHER00000/results');
      expect(service.pendingCount(CODE)).toBe(0);
      expect(service.pendingCount('OTHER00000')).toBe(1);
    });

    it('ignores queued entries that are not valid runs', () => {
      localStorage.setItem(PENDING_KEY, JSON.stringify([
        {code: CODE, token: 'tok-lan', runId: 'run-00000', stage: 1, correct: 6, total: 5},
        {code: CODE, token: 'tok-lan', stage: 1, correct: 1, total: 5},
        'junk',
        {code: CODE, token: 'tok-lan', runId: 'run-00003', stage: 2, correct: 4, total: 5},
      ]));

      expect(service.pendingCount(CODE)).toBe(1);
      service.flush(CODE).subscribe();
      const req = http.expectOne(RESULTS_URL);
      expect(req.request.body.runId).toBe('run-00003');
      req.flush(null, {status: 204, statusText: 'No Content'});
    });
  });

  describe('pendingByStage', () => {
    it('counts the queued runs of this student for each stage', () => {
      joined();
      expect(service.pendingByStage(CODE)).toEqual({});

      submitStage(1);
      failResult();
      submitStage(1);
      failResult();
      submitStage(4);
      failResult();

      expect(service.pendingByStage(CODE)).toEqual({'1': 2, '4': 1});
      expect(service.pendingByStage('OTHER00000')).toEqual({});
    });

    it('leaves out the runs of another student who used this device, and is empty without an identity', () => {
      joined();
      submitStage(2);
      failResult();

      joined({playerId: 'p2', token: 'tok-nam', name: 'Nam', avatar: ''});
      expect(service.pendingByStage(CODE)).toEqual({});

      service.forget(CODE);
      expect(service.pendingByStage(CODE)).toEqual({});
    });
  });

  describe('pendingCount', () => {
    it('counts the runs queued for a code', () => {
      expect(service.pendingCount(CODE)).toBe(0);

      joined();
      submitStage(1);
      failResult();
      submitStage(2);
      failResult();

      expect(service.pendingCount(CODE)).toBe(2);
      expect(service.pendingCount('OTHER00000')).toBe(0);
    });

    it('keeps the queue in memory when the storage is blocked', () => {
      joined();
      expect(service.identity(CODE)).toEqual(LAN); // read once while the storage still works
      spyOn(Storage.prototype, 'getItem').and.throwError('blocked');
      spyOn(Storage.prototype, 'setItem').and.throwError('blocked');

      submitStage();
      failResult();

      expect(service.pendingCount(CODE)).toBe(1);
    });
  });
});
