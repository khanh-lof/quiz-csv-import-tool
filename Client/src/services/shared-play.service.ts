import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { catchError, defer, map, Observable, of, switchMap, tap, throwError } from 'rxjs';
import { PlayerIdentity, SharedQuiz, StageSubmission, StudentBoard, SubmitOutcome } from '../models/assignment';

const IDENTITY_KEY = 'gesture-shared-players';
const PENDING_KEY = 'gesture-shared-pending';
// A device cannot have more runs waiting than a student could play, so this only stops a runaway queue
// from filling the storage.
const MAX_PENDING = 200;

// A finished run that could not be delivered yet. It carries its own token and runId, so a resend after a
// forget or a reload is still the same run, and the server counts it once.
interface PendingResult {
  code: string;
  token: string;
  runId: string;
  stage: number;
  correct: number;
  total: number;
}

type IdentityStore = Record<string, PlayerIdentity>;

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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

function sanitizePending(raw: unknown): PendingResult[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const list: PendingResult[] = [];
  for (const value of raw) {
    const {code, token, runId, stage, correct, total} = (value ?? {}) as Partial<Record<keyof PendingResult, unknown>>;
    if (isText(code) && isText(token) && isText(runId) && isWholeNumber(stage) && isWholeNumber(correct)
      && isWholeNumber(total) && correct <= total) {
      list.push({code: code.toUpperCase(), token, runId, stage, correct, total});
    }
  }
  return list.slice(-MAX_PENDING);
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

// A runId must be unique per finished run and match the server's ^[A-Za-z0-9-]{8,64}$. randomUUID exists
// only on HTTPS and localhost, and a classroom may well open the link over plain http on a local network.
function newRunId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

// A result is worth sending again when the server could not be reached or failed; any other answer, good
// or bad, is final.
function isTransient(status: number): boolean {
  return status === 0 || status >= 500;
}

// The student's side of "Giao bài": opening a shared quiz, joining it by name and avatar, changing the
// avatar, reading the leaderboard, and reporting each finished stage. The student has no account, so the server knows a device by the token it handed out on joining,
// which is kept here. Only the lazy play page uses this service.
@Injectable({providedIn: 'root'})
export class SharedPlayService {
  private readonly baseUrl = '/api/share';

  private readonly identities = new StoredValue<IdentityStore>(IDENTITY_KEY, sanitizeIdentities);
  private readonly pending = new StoredValue<PendingResult[]>(PENDING_KEY, sanitizePending);

  constructor(private readonly http: HttpClient) {
  }

  // 404 (no such code) and 410 (closed) are left for the page to read from the error. A device that has
  // joined sends its token, so the answer's `attempts` are this student's own; the token is optional on this
  // route, and one the server does not know is not an error, only an empty `attempts`.
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
  // request. A 403 from the server (the teacher removed the student) forgets the identity, like a result
  // does; every failure is rethrown for the page to explain: 400, 404, 410 (closed) or no connection.
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

  // Reports a finished stage. It never errors: the outcome says what became of the run.
  // The run gets its id here, once, and a failed send is not retried on its own: a run that could not be
  // delivered is queued with that same id, and the server counts an id it has seen only once.
  submit(code: string, submission: StageSubmission): Observable<SubmitOutcome> {
    const identity = this.identity(code);
    if (!identity) {
      return of('rejected');
    }
    const entry: PendingResult = {
      code: normalizeCode(code), token: identity.token, runId: newRunId(),
      stage: submission.stage, correct: submission.correct, total: submission.total,
    };
    return this.post(entry).pipe(
      map((status): SubmitOutcome => {
        if (status >= 200 && status < 300) {
          // The server is reachable: this is the moment to send what was left behind.
          this.flush(entry.code).subscribe();
          return 'saved';
        }
        if (isTransient(status)) {
          this.enqueue(entry);
          return 'queued';
        }
        if (status === 410) {
          return 'closed';
        }
        if (status === 409) {
          // `Replay limit reached`, the only conflict a result can meet: final, so it is not queued.
          return 'limit';
        }
        if (status === 403) {
          // The token is unknown to the server (the teacher removed this student): the identity is useless.
          this.forget(code);
        }
        return 'rejected';
      }));
  }

  // Sends the runs queued for `code`, oldest first, one at a time. An answer that is final (stored, or
  // refused for good) takes the run out of the queue; when the server cannot be reached the rest stays
  // queued for next time. Never errors.
  flush(code: string): Observable<void> {
    return defer(() => this.flushNext(normalizeCode(code)));
  }

  pendingCount(code: string): number {
    const key = normalizeCode(code);
    return this.pending.read().filter(entry => entry.code === key).length;
  }

  // The runs of each stage ("1" to "6") that this device's student has waiting in the queue. The server has not
  // counted them yet, so the page adds them to the server's `attempts` to count a run played offline.
  pendingByStage(code: string): Record<string, number> {
    const identity = this.identity(code);
    const key = normalizeCode(code);
    const counts: Record<string, number> = {};
    if (identity) {
      for (const entry of this.pending.read()) {
        if (entry.code === key && entry.token === identity.token) {
          counts[String(entry.stage)] = (counts[String(entry.stage)] ?? 0) + 1;
        }
      }
    }
    return counts;
  }

  // Reads the queue again before each send, so a second tab flushing the same queue does not make this one
  // resend what that tab already delivered.
  private flushNext(code: string): Observable<void> {
    const next = this.pending.read().find(entry => entry.code === code);
    if (!next) {
      return of(undefined);
    }
    return this.post(next).pipe(
      switchMap(status => {
        if (isTransient(status)) {
          return of(undefined);
        }
        this.dequeue(next.runId);
        return this.flushNext(code);
      }));
  }

  // The HTTP status of a result post, whatever it was: 0 stands for no answer at all (offline, a
  // dropped connection). It never errors, because every status has a meaning to the callers.
  private post(entry: PendingResult): Observable<number> {
    return this.http.post(`${this.baseUrl}/${encodeURIComponent(entry.code)}/results`,
      {runId: entry.runId, stage: entry.stage, correct: entry.correct, total: entry.total},
      {headers: {'X-Player-Token': entry.token}, observe: 'response'}).pipe(
      map(response => response.status),
      catchError(err => of(err instanceof HttpErrorResponse ? err.status : 0)));
  }

  private enqueue(entry: PendingResult): void {
    const queue = this.pending.read();
    if (!queue.some(queued => queued.runId === entry.runId)) {
      this.pending.write([...queue, entry].slice(-MAX_PENDING));
    }
  }

  private dequeue(runId: string): void {
    this.pending.write(this.pending.read().filter(entry => entry.runId !== runId));
  }
}
