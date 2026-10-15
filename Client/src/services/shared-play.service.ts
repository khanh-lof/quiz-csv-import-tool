import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { catchError, map, Observable, retry, tap, throwError, timer } from 'rxjs';
import { Choice } from '../game/stage-game';
import {
  PlayerIdentity,
  SharedQuestion,
  SharedQuiz,
  SharedRunStart,
  SharedVerdict,
  StudentBoard,
} from '../models/assignment';

const IDENTITY_KEY = 'gesture-shared-players';
// Where an older version of the page queued the results it could not deliver. Results are no longer reported
// by the browser, so nothing reads this any more: it is only cleared, once, from the devices that have it.
const OLD_PENDING_KEY = 'gesture-shared-pending';
// A transient failure of a request the server answers the same way twice is retried this many times, after
// one second and then after two.
const RETRY_COUNT = 2;
const RETRY_STEP_MS = 1000;

type IdentityStore = Record<string, PlayerIdentity>;

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

// Keeps only what looks like a stored identity: anything else (a hand-edited or older value) is dropped.
// An identity stored before avatars existed has none, which is the same as a student who did not pick one.
function sanitizeIdentities(raw: unknown): IdentityStore {
  const store: IdentityStore = {};
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [code, value] of Object.entries(raw)) {
      const {playerId, token, name, avatar} = (value ?? {}) as Partial<Record<keyof PlayerIdentity, unknown>>;
      if (isText(playerId) && isText(token) && isText(name)) {
        store[code.toUpperCase()] = {playerId, token, name, avatar: isText(avatar) ? avatar : ''};
      }
    }
  }
  return store;
}

// A value kept in localStorage. Blocked or full storage does not break the page: the value is then kept
// in memory, which lasts until the page is closed, like the stage progress.
class StoredValue<T> {
  private memory: T;
  private broken = false;

  constructor(private readonly key: string, private readonly sanitize: (raw: unknown) => T) {
    this.memory = sanitize(null);
  }

  read(): T {
    if (!this.broken) {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(this.key);
      } catch {
        this.broken = true;
        return this.memory;
      }
      try {
        this.memory = this.sanitize(raw ? JSON.parse(raw) : null);
      } catch {
        // Not JSON (hand-edited): nothing usable is stored, which is the same as an empty store.
        this.memory = this.sanitize(null);
      }
    }
    return this.memory;
  }

  write(value: T): void {
    this.memory = value;
    if (!this.broken) {
      try {
        localStorage.setItem(this.key, JSON.stringify(value));
      } catch {
        this.broken = true;
      }
    }
  }
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

// The server could not be reached (status 0, which is what a lost connection is) or failed: the same request may
// well work a moment later. Any other answer is final.
function isTransient(err: unknown): boolean {
  const status = err instanceof HttpErrorResponse ? err.status : 0;
  return status === 0 || status >= 500;
}

// The student's side of "Giao bài": opening a shared quiz, joining it by name and avatar, changing the
// avatar, reading the leaderboard, and playing a stage, which the server runs itself: it starts a run, deals the
// questions one at a time without their answers and judges each answer. The student has no account, so the server
// knows a device by the token it handed out on joining, which is kept here. Only the lazy play page uses this
// service.
@Injectable({providedIn: 'root'})
export class SharedPlayService {
  private readonly baseUrl = '/api/share';

  private readonly identities = new StoredValue<IdentityStore>(IDENTITY_KEY, sanitizeIdentities);

  constructor(private readonly http: HttpClient) {
    try {
      localStorage.removeItem(OLD_PENDING_KEY);
    } catch {
      // Blocked storage has nothing to clear.
    }
  }

  // 404 (no such code) and 410 (closed) are left for the page to read from the error. A device that has
  // joined sends its token, so the answer's `attempts` and `results` are this student's own; the token is
  // optional on this route, and one the server does not know is not an error, only an empty `attempts` and
  // `results`.
  load(code: string): Observable<SharedQuiz> {
    const token = this.identity(code)?.token;
    return this.http.get<SharedQuiz>(`${this.baseUrl}/${encodeURIComponent(code)}`,
      token ? {headers: {'X-Player-Token': token}} : {});
  }

  // Registers the student under `name` with the picked avatar (an id of `AVATARS`, '' for none) and
  // remembers the answer on this device. Failures are rethrown for the page to explain: 400 (bad name, or
  // `Invalid avatar.`), 409 (`Name taken` or `Assignment is full`), 404 and 410.
  join(code: string, name: string, avatar = ''): Observable<PlayerIdentity> {
    return this.http.post<PlayerIdentity>(`${this.baseUrl}/${encodeURIComponent(code)}/players`, {name, avatar}).pipe(
      map(({playerId, token, name: joinedName, avatar: joinedAvatar}) =>
        ({playerId, token, name: joinedName, avatar: joinedAvatar ?? ''})),
      tap(identity => this.identities.write({...this.identities.read(), [normalizeCode(code)]: identity})));
  }

  // Changes the avatar of the student this device joined as, and emits the identity as it is stored now. A
  // device that has not joined has no token to send, so it fails like the server would, with a 403 and no
  // request. A 403 from the server (the teacher removed the student) forgets the identity, like a run
  // request does; every failure is rethrown for the page to explain: 400, 404, 410 (closed) or no connection.
  setAvatar(code: string, avatar: string): Observable<PlayerIdentity> {
    const identity = this.identity(code);
    if (!identity) {
      return throwError(() => new HttpErrorResponse({status: 403, statusText: 'Forbidden', error: 'Unknown player'}));
    }
    return this.http.patch<Pick<PlayerIdentity, 'playerId' | 'name' | 'avatar'>>(
      `${this.baseUrl}/${encodeURIComponent(code)}/player`, {avatar}, {headers: {'X-Player-Token': identity.token}}).pipe(
      map(answer => {
        // The stored identity may have changed while the request was out (another tab joined as someone
        // else): only the student this request was for gets the new avatar.
        const current = this.identity(code);
        if (current?.token !== identity.token) {
          return {...identity, avatar: answer.avatar};
        }
        const updated = {...current, avatar: answer.avatar};
        this.identities.write({...this.identities.read(), [normalizeCode(code)]: updated});
        return updated;
      }),
      catchError(err => {
        if (err instanceof HttpErrorResponse && err.status === 403 && this.identity(code)?.token === identity.token) {
          this.forget(code);
        }
        return throwError(() => err);
      }));
  }

  // The board a student sees: the top of the leaderboard and, found by the device's token, the student's own
  // row. The token is optional on this route, and one the server does not know only makes `you` null. It
  // answers after the assignment closed too, so the closed card can show the final board; a 404 (no such
  // code, or `Board hidden` when the teacher hid the board from the students) is left for the caller.
  leaderboard(code: string): Observable<StudentBoard> {
    const token = this.identity(code)?.token;
    return this.http.get<StudentBoard>(`${this.baseUrl}/${encodeURIComponent(code)}/leaderboard`,
      token ? {headers: {'X-Player-Token': token}} : {});
  }

  // Who this device joined `code` as, or null.
  identity(code: string): PlayerIdentity | null {
    return this.identities.read()[normalizeCode(code)] ?? null;
  }

  // Lets this device join again as someone else. The old student stays in the teacher's leaderboard.
  forget(code: string): void {
    const rest = {...this.identities.read()};
    delete rest[normalizeCode(code)];
    this.identities.write(rest);
  }

  // Starts a run of `stage` (1 to 6) and emits its first question. The server counts the run toward the replay
  // limit from this moment, so a lost answer is not retried by itself: starting again would be a second run.
  // Failures are rethrown for the page to explain: 410 (closed), 403 (unknown student, which also forgets the
  // identity), 404, 400 `Invalid stage.`, 409 `Stage locked` or `Replay limit reached`, or no connection. A
  // device that has not joined has no token to send, so it fails like the server would, with no request.
  startRun(code: string, stage: number): Observable<SharedRunStart> {
    return this.asStudent(code, token => this.http.post<SharedRunStart>(
      `${this.baseUrl}/${encodeURIComponent(code)}/runs`, {stage}, {headers: {'X-Player-Token': token}}), false);
  }

  // The question after the one just answered. The server deals it the same way twice (a question already dealt
  // is sent again with its clock still running), so a transient failure is retried before it is reported.
  // Failures as for `startRun`, plus 404 `Run not found` and 409 `Run is over`.
  nextQuestion(code: string, runId: string): Observable<SharedQuestion> {
    return this.asStudent(code, token => this.http.post<{question: SharedQuestion}>(
      `${this.baseUrl}/${encodeURIComponent(code)}/runs/${encodeURIComponent(runId)}/next`, null,
      {headers: {'X-Player-Token': token}}).pipe(map(answer => answer.question)), true);
  }

  // Sends the answer to question `index` of the run and emits the server's verdict: `choice` is the option's
  // number, the sentence stage's pieces in the order picked, or null when the player's time ran out. An answer
  // already given is answered again with the same verdict and nothing is changed, so a transient failure is
  // retried before it is reported. Failures as for `nextQuestion`, plus 400 `Invalid answer.`
  answer(code: string, runId: string, index: number, choice: Choice | null): Observable<SharedVerdict> {
    return this.asStudent(code, token => this.http.post<SharedVerdict>(
      `${this.baseUrl}/${encodeURIComponent(code)}/runs/${encodeURIComponent(runId)}/answers`, {index, choice},
      {headers: {'X-Player-Token': token}}), true);
  }

  // A request made as the student this device joined as. Without an identity it fails as a 403 and sends
  // nothing, like the server would. A 403 from the server (the teacher removed the student) forgets the
  // identity, as it does for `setAvatar`; every failure is rethrown. `idempotent` requests are retried when the
  // failure is transient, after one second and then two.
  private asStudent<T>(code: string, send: (token: string) => Observable<T>, idempotent: boolean): Observable<T> {
    const identity = this.identity(code);
    if (!identity) {
      return throwError(() => new HttpErrorResponse({status: 403, statusText: 'Forbidden', error: 'Unknown player'}));
    }
    const request = send(identity.token);
    return (idempotent
      ? request.pipe(retry({
        count: RETRY_COUNT,
        delay: (err, attempt) => isTransient(err) ? timer(RETRY_STEP_MS * attempt) : throwError(() => err),
      }))
      : request
    ).pipe(catchError(err => {
      if (err instanceof HttpErrorResponse && err.status === 403 && this.identity(code)?.token === identity.token) {
        this.forget(code);
      }
      return throwError(() => err);
    }));
  }
}
