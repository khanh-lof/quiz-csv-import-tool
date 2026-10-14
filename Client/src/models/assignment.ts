import { HttpErrorResponse } from '@angular/common/http';
import { TimeMode } from '../components/gesture-play/gesture-settings.service';
import { STAGES, stagePosition } from '../game/stages';
import { Utils } from '../utils';
import { GestureQuiz } from './gesture-quiz';

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
  stageCounts: Record<string, number>;
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

// One row of the ranking. `rank` is null for a student who has joined but has no result yet (such
// students come last); `reachedAt` is when the student's current score was reached.
export interface RankedPlayer {
  id: string;
  name: string;
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

// GET /api/assignments/{id}: the assignment, the quiz it snapshotted (the AI's raw CSV) and the ranking.
export interface AssignmentDetail extends Assignment {
  csv: string;
  players: RankedPlayer[];
}

// GET /api/share/{code}: what a student's page needs to play.
export interface SharedQuiz {
  title: string;
  label: string;
  csv: string;
  timeMode: TimeMode;
  stageLock: StageLock;
  closesAt: string | null;
}

// The body of POST /api/assignments.
export interface NewAssignment {
  jobId: string;
  label: string;
  closesAt: string | null;
  timeMode: TimeMode;
  stageLock: StageLock;
  stageCounts: Record<string, number>;
}

// The body of PATCH /api/assignments/{id}: a key left out stays unchanged, `closesAt: null` removes
// the closing time, `closed: true` closes now and `closed: false` reopens.
export interface AssignmentChange {
  label?: string;
  closesAt?: string | null;
  closed?: boolean;
}

// What the server gave a student who joined, kept on the device so a reload resumes as the same student.
export interface PlayerIdentity {
  playerId: string;
  token: string;
  name: string;
}

// One finished run of a stage, as the browser reports it.
export interface StageSubmission {
  stage: number;
  correct: number;
  total: number;
}

// What became of a reported run: stored on the server, kept on the device to be resent, refused because
// the assignment is over, or refused as invalid (or as coming from an unknown student).
export type SubmitOutcome = 'saved' | 'queued' | 'closed' | 'rejected';

export const TIME_MODE_LABELS: Record<TimeMode, string> = {
  standard: 'Bình thường',
  extra: 'Thêm thời gian (×1.5)',
  unlimited: 'Không giới hạn',
};

export const STAGE_LOCK_LABELS: Record<StageLock, string> = {
  sequential: 'Phải qua màn trước mới mở màn sau',
  open: 'Mở tất cả các màn',
};

// The link a student opens. The origin is a parameter so a spec does not depend on where it runs.
export function shareUrl(code: string, origin: string = location.origin): string {
  return `${origin}/play/s/${code}`;
}

// The stages that have questions, by number ("1" to "6"), as the server wants them on create.
export function stageCountsOf(quiz: GestureQuiz): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [stage, questions] of quiz.stages) {
    if (questions.length > 0) {
      counts[String(stage)] = questions.length;
    }
  }
  return counts;
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

// 'dd/MM/yyyy HH:mm' in the browser's time zone, for the downloaded ranking.
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

// The header of a stage's column in the ranking: the stage's position among the assignment's stages and
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
  'Assignment not found': 'Không tìm thấy bài này, có thể nó đã bị xóa.',
  'Job not found': 'Không tìm thấy quiz này, có thể nó đã bị xóa khỏi bảng lịch sử.',
  'Player not found': 'Học sinh này đã được xóa rồi.',
  'Too many assignments.': 'Bạn đã có 100 bài giao. Hãy xóa bớt bài cũ ở trang Bài đã giao.',
  'Job is not a finished gesture quiz.': 'Chỉ giao được Game đã tạo xong.',
  'Invalid closing time.': 'Giờ đóng phải ở tương lai (tối đa 180 ngày).',
  'Label is too long.': 'Tên lớp/nhóm dài tối đa 60 ký tự.',
  'Invalid stage counts.': 'Quiz này không có câu hỏi hợp lệ để giao.',
};

// What to tell the teacher when an AssignmentService call fails.
export function assignmentErrorMessage(err: unknown): string {
  if (!(err instanceof HttpErrorResponse)) {
    return 'Có lỗi xảy ra, vui lòng thử lại.';
  }
  if (err.status === 0) {
    return 'Mất kết nối tới máy chủ. Hãy kiểm tra mạng rồi thử lại.';
  }
  if (err.status === 401) {
    return 'Phiên đăng nhập đã hết, hãy đăng nhập lại.';
  }
  const body = typeof err.error === 'string' ? err.error.trim() : '';
  return TEACHER_ERRORS[body] ?? (err.status === 400 ? 'Yêu cầu chưa hợp lệ.' : 'Có lỗi xảy ra, vui lòng thử lại.');
}

// The ranking as a CSV file, rows in the order given (the server's ranking order). It starts with a BOM so
// Excel reads the UTF-8 (the Vietnamese headers and names) correctly, and uses CRLF line ends.
export function rankingCsv(detail: AssignmentDetail): string {
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
