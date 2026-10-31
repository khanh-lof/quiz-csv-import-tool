import { HttpErrorResponse } from '@angular/common/http';
import { TimeMode } from '../components/gesture-play/gesture-settings.service';
import { DEFAULT_PASS_PERCENT, stagePosition, STAGES } from '../game/stages';
import { Utils } from '../utils';
import { GestureQuestion, GestureQuiz } from './gesture-quiz';

export { DEFAULT_PASS_PERCENT, MAX_PASS_PERCENT, MIN_PASS_PERCENT } from '../game/stages';

// The replay limit a teacher may set per stage, as the server checks it (1 to 10); the dialog starts at the default.
export const MIN_ATTEMPTS_LIMIT = 1;
export const MAX_ATTEMPTS_LIMIT = 10;
export const DEFAULT_ATTEMPTS_LIMIT = 3;

// The shapes of the "Giao bài" API (Server/internal/api/assignment_handlers.go and share_handlers.go),
// kept in step with the server by hand. Times travel as RFC 3339 strings.

// One quiz a teacher handed to students. `stageCounts` maps a stage ("1" to "6") to its number of
// questions and holds only the stages the quiz has. `open` is what the server computed when it answered,
// so a page left open goes stale: use `isOpenAt` to know whether it is still open now.
export type StageLock = 'sequential' | 'open';

export interface Assignment {
  id: string;
  code: string;
  jobId: string;
  title: string;
  label: string;
  timeMode: TimeMode;
  stageLock: StageLock;
  passPercents: Record<string, number>;
  maxAttempts: number | null;
  // Whether the students see the board, the top five and their own place. Fixed for the assignment's life.
  showBoard: boolean;
  stageCounts: Record<string, number>;
  // The seconds each question of a stage ("1" to "6", one key per stage of `stageCounts`) lasts, with the time
  // mode already applied, or null when the time mode is unlimited. They are the server's, from its configuration,
  // and may differ from the `seconds` of `STAGES`: the page uses them instead of those for an assignment.
  timeLimits: Record<string, number | null>;
  createdAt: string;
  closesAt: string | null;
  closedAt: string | null;
  open: boolean;
  playerCount: number;
}

// A student's best run of one stage.
export interface StageScore {
  correct: number;
  total: number;
  passed: boolean;
  attempts: number;
}

// One row of the leaderboard. `rank` is null for a student who has joined but has no result yet (such
// students come last); `reachedAt` is when the student's current score was reached. `avatar` is the id of
// one of `AVATARS` (models/avatar.ts), or '' for a student who joined without picking one.
export interface LeaderboardEntry {
  id: string;
  name: string;
  avatar: string;
  rank: number | null;
  stagesPassed: number;
  correct: number;
  possible: number;
  attempts: number;
  stages: Record<string, StageScore>;
  joinedAt: string;
  lastPlayedAt: string | null;
  reachedAt: string | null;
}

// GET /api/assignments/{id}: the assignment, the quiz it snapshotted (the AI's raw CSV) and the leaderboard
// (the JSON key stays `players`).
export interface AssignmentDetail extends Assignment {
  csv: string;
  players: LeaderboardEntry[];
}

// A student's best run of one stage, as the server holds it (GET share/{code}'s `results`).
export interface SharedStageResult {
  correct: number;
  total: number;
  passed: boolean;
}

// GET /api/share/{code}: what a student's page needs to play. It carries no questions: the server keeps the
// quiz and deals one question at a time (see `SharedQuestion`), so `stageCounts` is all the page knows of it.
export interface SharedQuiz {
  title: string;
  label: string;
  timeMode: TimeMode;
  stageLock: StageLock;
  passPercents: Record<string, number>;
  // The most runs of a stage a student may have (1 to 10), or null for no limit.
  maxAttempts: number | null;
  // Whether the students see the board, the top five and their own place (GET share/{code}/leaderboard).
  showBoard: boolean;
  // How many questions each stage ("1" to "6") has, only the stages the quiz has.
  stageCounts: Record<string, number>;
  // The seconds each question of a stage lasts, time mode applied, null for no limit: the server's, from its
  // configuration, which the page uses instead of the `seconds` of `STAGES` for an assignment.
  timeLimits: Record<string, number | null>;
  // The runs of each stage ("1" to "6") the student who sent the X-Player-Token header has started (a run
  // counts the moment it starts); empty without a valid token.
  attempts: Record<string, number>;
  // That student's best result of each stage that has one; empty without a valid token.
  results: Record<string, SharedStageResult>;
  closesAt: string | null;
}

// One question the server dealt (POST share/{code}/runs and .../next). `index` is its place in the run
// (0 to total - 1), `options` the answers as shown (empty for the sentence stage, whose `chunks` are the
// shuffled pieces; `chunks` is null for the others). The answer is not in it. `timeLeftMs` is how long the
// player has from the moment the server dealt it (null: no time limit) and `graceMs` the extra time the
// server allows for the network on top of that.
export interface SharedQuestion {
  index: number;
  question: string;
  options: string[];
  chunks?: string[] | null;
  timeLeftMs: number | null;
  graceMs: number;
}

// POST share/{code}/runs: the run that was started, how many questions it has, the runs of this stage the
// student has used now (this one included) and its first question.
export interface SharedRunStart {
  runId: string;
  stage: number;
  total: number;
  attempts: number;
  question: SharedQuestion;
}

// POST share/{code}/runs/{runId}/answers: what the server made of an answer. `correctIndex` is set for the
// option stages and `correctOrder` for the sentence stage; `answer` is the right answer's text and
// `explanation` the teacher's sentence about it. `result` is only on the run's last question.
export interface SharedVerdict {
  correct: boolean;
  timedOut: boolean;
  correctIndex?: number | null;
  correctOrder?: string[] | null;
  answer: string;
  explanation: string;
  result: SharedStageResult | null;
}

// The body of POST /api/assignments.
export interface NewAssignment {
  jobId: string;
  label: string;
  closesAt: string | null;
  timeMode: TimeMode;
  stageLock: StageLock;
  passPercents: Record<string, number>;
  // The replay limit per stage (1 to 10), null or left out for none. The server accepts it only with the
  // `open` stage lock.
  maxAttempts?: number | null;
  // Whether the students see the board; the dialog always sends it (the server reads a missing one as true).
  showBoard: boolean;
}

// The body of PATCH /api/assignments/{id}: a key left out stays unchanged, `closesAt: null` removes
// the closing time, `closed: true` closes now and `closed: false` reopens.
export interface AssignmentChange {
  label?: string;
  closesAt?: string | null;
  closed?: boolean;
}

// What the server gave a student who joined, kept on the device so a reload resumes as the same student.
// `avatar` is '' for a student who joined without one, and for an identity stored before avatars existed.
export interface PlayerIdentity {
  playerId: string;
  token: string;
  name: string;
  avatar: string;
}

// One row of the board a student sees (GET /api/share/{code}/leaderboard). It carries no player id, only what
// is shown: `rank` is null for the student's own row when they have no result yet, and `you` marks, in
// `top`, the row of the student who sent the X-Player-Token header.
export interface StudentBoardEntry {
  rank: number | null;
  name: string;
  avatar: string;
  stagesPassed: number;
  correct: number;
  you?: boolean;
}

// What a student sees of the leaderboard: the ranked players of rank 5 or better (`top`, in order, a tie at
// 5th may add rows, at most 10), the student's own row (`you`, null without a valid token), the points
// possible, how many stages the assignment has and how many students joined.
export interface StudentBoard {
  top: StudentBoardEntry[];
  you: StudentBoardEntry | null;
  possible: number;
  stageCount: number;
  playerCount: number;
}

export const TIME_MODE_LABELS: Record<TimeMode, string> = {
  standard: 'Chuẩn',
  extra: 'Thêm giờ (×1,5)',
  unlimited: 'Không giới hạn',
};

export const STAGE_LOCK_LABELS: Record<StageLock, string> = {
  sequential: 'Phải qua màn trước mới mở màn sau',
  open: 'Mở tất cả các màn',
};

// The percentage of correct answers that passes a stage, from an assignment's `passPercents` (stage "1" to
// "6", the server always sends a complete map). Falls back to the default for a stage the map lacks, or
// when there is no assignment.
export function passPercentOf(passPercents: Record<string, number> | null | undefined, stage: number): number {
  return passPercents?.[String(stage)] ?? DEFAULT_PASS_PERCENT;
}

// The runs a student has left on a stage: the limit less the runs already used, never below 0, or null when
// there is no limit.
export function attemptsLeft(maxAttempts: number | null | undefined, used: number | undefined): number | null {
  return maxAttempts === null || maxAttempts === undefined ? null : Math.max(0, maxAttempts - (used ?? 0));
}

// The link a student opens. The origin is a parameter so a spec does not depend on where it runs.
export function shareUrl(code: string, origin: string = location.origin): string {
  return `${origin}/play/s/${code}`;
}

// The quiz a student's page holds before it has played anything: each stage the assignment has (`stageCounts`,
// "1" to "6") with that many blank placeholder questions. Their text is never shown or played, the server deals
// the real questions one at a time; they only give the map, the intro and the locks the shape of the quiz. A key
// that is not a stage, or a count that is not a positive whole number, is left out.
export function placeholderQuiz(title: string, key: string, stageCounts: Record<string, number>): GestureQuiz {
  const stages = new Map<number, GestureQuestion[]>();
  for (const { stage } of STAGES) {
    const count = stageCounts[String(stage)];
    if (Number.isInteger(count) && count > 0) {
      stages.set(stage, Array.from({ length: count }, (): GestureQuestion =>
        ({
          stage,
          question: '',
          correct: '',
          wrong: [],
          explanation: ''
        })));
    }
  }
  return {
    title,
    key,
    stages,
    skipped: 0
  };
}

// Same rule as the server's Assignment.OpenAt: not closed by hand and not past its closing time. The
// `open` flag of an Assignment is only as fresh as the response that carried it, this is computed.
export function isOpenAt(assignment: Assignment, now: Date): boolean {
  return assignment.closedAt === null
    && (assignment.closesAt === null || now.getTime() < new Date(assignment.closesAt).getTime());
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

// 'HH:mm dd/MM' in the browser's time zone, written out by hand so it never depends on a locale.
export function formatClose(time: Date | string): string {
  const d = typeof time === 'string' ? new Date(time) : time;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
}

// 'dd/MM/yyyy HH:mm' in the browser's time zone, for the downloaded leaderboard.
export function formatStamp(time: Date | string): string {
  const d = typeof time === 'string' ? new Date(time) : time;
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// The status of an assignment in words: 'Đã đóng', 'Đang mở · đóng lúc 21:30 14/10' or 'Đang mở'.
export function assignmentStatusText(assignment: Assignment, now: Date): string {
  if (!isOpenAt(assignment, now)) {
    return 'Đã đóng';
  }
  return assignment.closesAt === null ? 'Đang mở' : `Đang mở · đóng lúc ${formatClose(assignment.closesAt)}`;
}

// The stage numbers an assignment has, in order.
function stageKeys(stageCounts: Record<string, number>): string[] {
  return Object.keys(stageCounts).sort((a, b) => Number(a) - Number(b));
}

// The header of a stage's column in the leaderboard: the stage's position among the assignment's stages and
// the game played there, "Màn 2 (Xếp câu)". The stage number (the key) is only the game's identity.
function stageHeader(keys: string[], key: string): string {
  const position = stagePosition(keys.map(Number), Number(key));
  const def = STAGES.find(stage => stage.stage === Number(key));
  return def ? `Màn ${position} (${def.name})` : `Màn ${position}`;
}

const BOM = String.fromCharCode(0xfeff);

// A student's name is typed by the student and opened by the teacher in a spreadsheet, where a cell
// starting with one of these characters runs as a formula. A leading apostrophe makes it plain text.
function spreadsheetSafe(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

// The server's plain-text answers to a teacher's assignment request, in words a teacher can act on.
const TEACHER_ERRORS: Record<string, string> = {
  'Assignment not found': 'Không tìm thấy bài này.',
  'Job not found': 'Không tìm thấy quiz này trong Lịch sử.',
  'Player not found': 'Học sinh này đã bị xóa.',
  'Too many assignments.': 'Tối đa 100 bài. Xóa bớt ở Bài đã giao.',
  'Job is not a finished gesture quiz.': 'Chỉ giao được Game đã tạo xong và có câu hỏi hợp lệ.',
  'Invalid closing time.': 'Giờ đóng phải ở tương lai (tối đa 180 ngày).',
  'Label is too long.': 'Tên lớp / nhóm tối đa 60 ký tự.',
  'Invalid pass percents.': 'Điểm qua màn phải từ 10% đến 100%.',
  'Invalid replay limit.': 'Số lần chơi mỗi màn: 1–10, chỉ khi mở tất cả các màn.',
  'Invalid board setting.': 'Cài đặt bảng xếp hạng cho học sinh không hợp lệ.',
};

// What to tell the teacher when an AssignmentService call fails.
export function assignmentErrorMessage(err: unknown): string {
  if (!(err instanceof HttpErrorResponse)) {
    return 'Thử lại.';
  }
  if (err.status === 0) {
    return 'Mất kết nối. Kiểm tra mạng rồi thử lại.';
  }
  if (err.status === 401) {
    return 'Hết phiên đăng nhập. Đăng nhập lại.';
  }
  const body = typeof err.error === 'string' ? err.error.trim() : '';
  return TEACHER_ERRORS[body] ?? (err.status === 400 ? 'Yêu cầu chưa hợp lệ.' : 'Thử lại.');
}

// The leaderboard as a CSV file, rows in the order given (the server's leaderboard order). It starts with a BOM
// so Excel reads the UTF-8 (the Vietnamese headers and names) correctly, and uses CRLF line ends. It has no
// avatar column: a picture means nothing in a spreadsheet.
export function leaderboardCsv(detail: AssignmentDetail): string {
  const stages = stageKeys(detail.stageCounts);
  const header = ['Hạng', 'Tên', 'Màn đã qua', 'Câu đúng', ...stages.map(stage => stageHeader(stages, stage)), 'Lần chơi', 'Cập nhật'];
  const rows = detail.players.map((player): (string | number)[] => [
    player.rank ?? '',
    spreadsheetSafe(player.name),
    `${player.stagesPassed}/${stages.length}`,
    `${player.correct}/${player.possible}`,
    ...stages.map(stage => {
      const score = player.stages[stage];
      return score ? `${score.correct}/${score.total}${score.passed ? ' ✓' : ''}` : '';
    }),
    player.attempts,
    player.lastPlayedAt ? formatStamp(player.lastPlayedAt) : '',
  ]);
  const lines = [header, ...rows].map(row => row.map(field => Utils.escapeCsvField(field)).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}
