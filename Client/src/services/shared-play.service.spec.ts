import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { HttpClient, HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PlayerIdentity, SharedQuestion, SharedRunStart, SharedVerdict, StudentBoard } from '../models/assignment';
import { SharedPlayService } from './shared-play.service';

const IDENTITY_KEY = 'gesture-shared-players';
const OLD_PENDING_KEY = 'gesture-shared-pending';
const CODE = 'K7M2X9QD4P';
const RUNS_URL = `/api/share/${CODE}/runs`;

const LAN: PlayerIdentity = {playerId: 'p1', token: 'tok-lan', name: 'Lan', avatar: 'cat'};

const QUESTION: SharedQuestion = {
  index: 0, question: '你好', options: ['Xin chào', 'Tạm biệt'], chunks: null, timeLeftMs: 12000, graceMs: 5000,
};
const VERDICT: SharedVerdict = {
  correct: true, timedOut: false, correctIndex: 0, answer: 'Xin chào', explanation: '你好 là xin chào.', result: null,
};

describe('SharedPlayService', () => {
  let service: SharedPlayService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.removeItem(IDENTITY_KEY);
    localStorage.removeItem(OLD_PENDING_KEY);
    TestBed.configureTestingModule({providers: [provideHttpClient(), provideHttpClientTesting()]});
    service = TestBed.inject(SharedPlayService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    localStorage.removeItem(IDENTITY_KEY);
    localStorage.removeItem(OLD_PENDING_KEY);
  });

  // Gives this device an identity for CODE without going through a join.
  function joined(identity: PlayerIdentity = LAN): void {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({[CODE]: identity}));
  }

  describe('load', () => {
    it('gets the shared quiz by its code', () => {
      let title = '';
      service.load(CODE).subscribe(quiz => title = quiz.title);

      const req = http.expectOne(`/api/share/${CODE}`);
      expect(req.request.method).toBe('GET');
      req.flush({title: 'HSK1 bài 1', label: '6A', timeMode: 'standard', stageLock: 'sequential', passPercents: {'1': 70}, maxAttempts: null, showBoard: true, stageCounts: {'1': 5}, attempts: {}, results: {}, closesAt: null});
      expect(title).toBe('HSK1 bài 1');
    });

    it('sends no player header from a device that has not joined', () => {
      service.load(CODE).subscribe();

      const req = http.expectOne(`/api/share/${CODE}`);
      expect(req.request.headers.has('X-Player-Token')).toBeFalse();
      req.flush({});
    });

    it('sends the stored token, so the answer holds the attempts and the results of this student', () => {
      joined();
      let attempts: Record<string, number> = {};
      let results: Record<string, unknown> = {};
      service.load(CODE.toLowerCase()).subscribe(quiz => {
        attempts = quiz.attempts;
        results = quiz.results;
      });

      const req = http.expectOne(`/api/share/${CODE.toLowerCase()}`);
      expect(req.request.headers.get('X-Player-Token')).toBe('tok-lan');
      req.flush({title: 'HSK1 bài 1', maxAttempts: 3, attempts: {'1': 2, '4': 1}, results: {'1': {correct: 4, total: 5, passed: true}}});
      expect(attempts).toEqual({'1': 2, '4': 1});
      expect(results).toEqual({'1': {correct: 4, total: 5, passed: true}});
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

  describe('the old queue of results', () => {
    it('is cleared from the device when the service starts, and nothing else is touched', () => {
      localStorage.setItem(OLD_PENDING_KEY, JSON.stringify([{code: CODE, token: 't', runId: 'r', stage: 1, correct: 1, total: 5}]));
      joined();

      new SharedPlayService(TestBed.inject(HttpClient));

      expect(localStorage.getItem(OLD_PENDING_KEY)).toBeNull();
      expect(localStorage.getItem(IDENTITY_KEY)).not.toBeNull();
    });

    it('does not break a service started with the storage blocked', () => {
      const removeItem = spyOn(Storage.prototype, 'removeItem').and.throwError('blocked');

      expect(() => new SharedPlayService(TestBed.inject(HttpClient))).not.toThrow();
      // The specs' own cleanup removes items too.
      removeItem.and.callThrough();
    });
  });

  // The server runs a stage itself: the browser starts a run, is dealt one question at a time and sends each
  // answer, and the server judges it.
  describe('startRun', () => {
    const START: SharedRunStart = {runId: 'run-1', stage: 2, total: 5, attempts: 1, question: QUESTION};

    function start(stage = 2): { starts: SharedRunStart[]; errors: HttpErrorResponse[] } {
      const result = {starts: [] as SharedRunStart[], errors: [] as HttpErrorResponse[]};
      service.startRun(CODE, stage).subscribe({
        next: run => result.starts.push(run),
        error: (e: HttpErrorResponse) => result.errors.push(e),
      });
      return result;
    }

    it('posts the stage with the token in a header and emits the run with its first question', () => {
      joined();
      const result = start(2);

      const req = http.expectOne(RUNS_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('X-Player-Token')).toBe('tok-lan');
      expect(req.request.body).toEqual({stage: 2});
      req.flush(START, {status: 201, statusText: 'Created'});

      expect(result.starts).toEqual([START]);
    });

    it('finds the identity whatever the case of the code', () => {
      joined();

      service.startRun(CODE.toLowerCase(), 1).subscribe();

      const req = http.expectOne(`/api/share/${CODE.toLowerCase()}/runs`);
      expect(req.request.headers.get('X-Player-Token')).toBe('tok-lan');
      req.flush(START);
    });

    it('fails with a 403 and sends nothing when this device has not joined', () => {
      const result = start();

      http.expectNone(RUNS_URL);
      expect(result.starts).toEqual([]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0] instanceof HttpErrorResponse).toBeTrue();
      expect(result.errors[0].status).toBe(403);
    });

    it('forgets the identity on a 403 (the teacher removed the student) and rethrows it', () => {
      joined();
      const result = start();

      http.expectOne(RUNS_URL).flush('Unknown player', {status: 403, statusText: 'Forbidden'});

      expect(result.errors.map(e => [e.status, e.error])).toEqual([[403, 'Unknown player']]);
      expect(service.identity(CODE)).toBeNull();
    });

    it('does not forget another student the device switched to while the request was out', () => {
      joined();
      start();
      const nam: PlayerIdentity = {playerId: 'p2', token: 'tok-nam', name: 'Nam', avatar: 'owl'};
      joined(nam);

      http.expectOne(RUNS_URL).flush('Unknown player', {status: 403, statusText: 'Forbidden'});

      expect(service.identity(CODE)).toEqual(nam);
    });

    it('rethrows every other failure unchanged and keeps the identity', () => {
      joined();
      for (const [status, body] of [[410, 'Assignment closed'], [404, 'Assignment not found'], [400, 'Invalid stage.'],
        [409, 'Stage locked'], [409, 'Replay limit reached']] as const) {
        const result = start();
        http.expectOne(RUNS_URL).flush(body, {status, statusText: 'x'});
        expect(result.errors.map(e => [e.status, e.error])).toEqual([[status, body]]);
      }
      expect(service.identity(CODE)).toEqual(LAN);
    });

    it('does not retry a failure by itself, since another start would be another run', fakeAsync(() => {
      joined();

      const lost = start();
      http.expectOne(RUNS_URL).error(new ProgressEvent('error'), {status: 0});
      tick(10000);
      http.expectNone(RUNS_URL);
      expect(lost.errors.map(e => e.status)).toEqual([0]);

      const failed = start();
      http.expectOne(RUNS_URL).flush('boom', {status: 500, statusText: 'Server Error'});
      tick(10000);
      http.expectNone(RUNS_URL);
      expect(failed.errors.map(e => e.status)).toEqual([500]);
    }));
  });

  describe('nextQuestion', () => {
    const NEXT_URL = `${RUNS_URL}/run-1/next`;

    function next(): { questions: SharedQuestion[]; errors: HttpErrorResponse[] } {
      const result = {questions: [] as SharedQuestion[], errors: [] as HttpErrorResponse[]};
      service.nextQuestion(CODE, 'run-1').subscribe({
        next: question => result.questions.push(question),
        error: (e: HttpErrorResponse) => result.errors.push(e),
      });
      return result;
    }

    it('posts with the token and no body, and emits the question of the answer', () => {
      joined();
      const result = next();

      const req = http.expectOne(NEXT_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('X-Player-Token')).toBe('tok-lan');
      expect(req.request.body).toBeNull();
      req.flush({question: {...QUESTION, index: 1}});

      expect(result.questions).toEqual([{...QUESTION, index: 1}]);
    });

    it('escapes the run id in the URL', () => {
      joined();

      service.nextQuestion(CODE, 'a/b c').subscribe();

      const req = http.expectOne(`${RUNS_URL}/a%2Fb%20c/next`);
      expect(req.request.url).toBe(`${RUNS_URL}/a%2Fb%20c/next`);
      req.flush({question: QUESTION});
    });

    it('fails with a 403 and sends nothing when this device has not joined', () => {
      const result = next();

      http.expectNone(NEXT_URL);
      expect(result.errors.map(e => e.status)).toEqual([403]);
    });

    it('forgets the identity on a 403 and rethrows it, without retrying', fakeAsync(() => {
      joined();
      const result = next();

      http.expectOne(NEXT_URL).flush('Unknown player', {status: 403, statusText: 'Forbidden'});
      tick(10000);

      http.expectNone(NEXT_URL);
      expect(result.errors.map(e => [e.status, e.error])).toEqual([[403, 'Unknown player']]);
      expect(service.identity(CODE)).toBeNull();
    }));

    it('rethrows a final failure at once, without retrying', fakeAsync(() => {
      joined();
      for (const [status, body] of [[410, 'Assignment closed'], [404, 'Run not found'], [409, 'Run is over']] as const) {
        const result = next();
        http.expectOne(NEXT_URL).flush(body, {status, statusText: 'x'});
        tick(10000);
        http.expectNone(NEXT_URL);
        expect(result.errors.map(e => [e.status, e.error])).toEqual([[status, body]]);
      }
    }));

    it('retries a lost connection after 1 s and then after 2 s, and emits what finally comes', fakeAsync(() => {
      joined();
      const result = next();

      http.expectOne(NEXT_URL).error(new ProgressEvent('error'), {status: 0});
      tick(999);
      http.expectNone(NEXT_URL);
      tick(1);
      http.expectOne(NEXT_URL).flush('boom', {status: 503, statusText: 'Service Unavailable'});
      tick(1999);
      http.expectNone(NEXT_URL);
      tick(1);
      http.expectOne(NEXT_URL).flush({question: QUESTION});

      expect(result.questions).toEqual([QUESTION]);
      expect(result.errors).toEqual([]);
    }));

    it('gives up after two retries and rethrows the last failure', fakeAsync(() => {
      joined();
      const result = next();

      http.expectOne(NEXT_URL).error(new ProgressEvent('error'), {status: 0});
      tick(1000);
      http.expectOne(NEXT_URL).error(new ProgressEvent('error'), {status: 0});
      tick(2000);
      http.expectOne(NEXT_URL).flush('boom', {status: 500, statusText: 'Server Error'});
      tick(10000);

      http.expectNone(NEXT_URL);
      expect(result.errors.map(e => e.status)).toEqual([500]);
      expect(service.identity(CODE)).toEqual(LAN);
    }));
  });

  describe('answer', () => {
    const ANSWERS_URL = `${RUNS_URL}/run-1/answers`;

    function answer(index = 0, choice: number | string[] | null = 1): { verdicts: SharedVerdict[]; errors: HttpErrorResponse[] } {
      const result = {verdicts: [] as SharedVerdict[], errors: [] as HttpErrorResponse[]};
      service.answer(CODE, 'run-1', index, choice).subscribe({
        next: verdict => result.verdicts.push(verdict),
        error: (e: HttpErrorResponse) => result.errors.push(e),
      });
      return result;
    }

    it('posts the question\'s number and the choice with the token, and emits the verdict', () => {
      joined();
      const result = answer(3, 1);

      const req = http.expectOne(ANSWERS_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('X-Player-Token')).toBe('tok-lan');
      expect(req.request.body).toEqual({index: 3, choice: 1});
      req.flush(VERDICT);

      expect(result.verdicts).toEqual([VERDICT]);
    });

    it("sends null when the player's time ran out", () => {
      joined();

      answer(1, null);

      const req = http.expectOne(ANSWERS_URL);
      expect(req.request.body).toEqual({index: 1, choice: null});
      req.flush({...VERDICT, correct: false, timedOut: true});
    });

    it('sends the pieces of a sentence in the order they were picked', () => {
      joined();

      answer(0, ['我', '是', '兰']);

      const req = http.expectOne(ANSWERS_URL);
      expect(req.request.body).toEqual({index: 0, choice: ['我', '是', '兰']});
      req.flush(VERDICT);
    });

    it('fails with a 403 and sends nothing when this device has not joined', () => {
      const result = answer();

      http.expectNone(ANSWERS_URL);
      expect(result.errors.map(e => e.status)).toEqual([403]);
    });

    it('forgets the identity on a 403 and rethrows it', () => {
      joined();
      const result = answer();

      http.expectOne(ANSWERS_URL).flush('Unknown player', {status: 403, statusText: 'Forbidden'});

      expect(result.errors.map(e => [e.status, e.error])).toEqual([[403, 'Unknown player']]);
      expect(service.identity(CODE)).toBeNull();
    });

    it('rethrows a final failure at once, without retrying', fakeAsync(() => {
      joined();
      for (const [status, body] of [[410, 'Assignment closed'], [404, 'Run not found'], [400, 'Invalid answer.']] as const) {
        const result = answer();
        http.expectOne(ANSWERS_URL).flush(body, {status, statusText: 'x'});
        tick(10000);
        http.expectNone(ANSWERS_URL);
        expect(result.errors.map(e => [e.status, e.error])).toEqual([[status, body]]);
      }
    }));

    it('retries a transient failure with the same body after 1 s and then after 2 s', fakeAsync(() => {
      joined();
      const result = answer(2, 0);

      http.expectOne(ANSWERS_URL).flush('boom', {status: 502, statusText: 'Bad Gateway'});
      tick(1000);
      const second = http.expectOne(ANSWERS_URL);
      expect(second.request.body).toEqual({index: 2, choice: 0});
      second.error(new ProgressEvent('error'), {status: 0});
      tick(2000);
      http.expectOne(ANSWERS_URL).flush(VERDICT);

      expect(result.verdicts).toEqual([VERDICT]);
      expect(result.errors).toEqual([]);
    }));

    it('gives up after two retries, rethrows the last failure and keeps the identity', fakeAsync(() => {
      joined();
      const result = answer();

      http.expectOne(ANSWERS_URL).error(new ProgressEvent('error'), {status: 0});
      tick(1000);
      http.expectOne(ANSWERS_URL).error(new ProgressEvent('error'), {status: 0});
      tick(2000);
      http.expectOne(ANSWERS_URL).error(new ProgressEvent('error'), {status: 0});
      tick(10000);

      http.expectNone(ANSWERS_URL);
      expect(result.errors.map(e => e.status)).toEqual([0]);
      expect(service.identity(CODE)).toEqual(LAN);
    }));

    it('does not retry once the subscriber is gone', fakeAsync(() => {
      joined();
      const subscription = service.answer(CODE, 'run-1', 0, 1).subscribe({error: () => undefined});

      http.expectOne(ANSWERS_URL).error(new ProgressEvent('error'), {status: 0});
      subscription.unsubscribe();
      tick(10000);

      expect(http.match(ANSWERS_URL)).toEqual([]);
    }));
  });
});
