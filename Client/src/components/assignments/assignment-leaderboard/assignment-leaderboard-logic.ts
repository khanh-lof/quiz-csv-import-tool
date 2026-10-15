import { Assignment, AssignmentDetail, isOpenAt, LeaderboardEntry } from '../../../models/assignment';

// How long after the close a student's result is still accepted (the server's grace period), so how long
// the leaderboard keeps changing and is worth refreshing by itself.
export const RESULT_GRACE_MS = 5 * 60 * 1000;

// The moment the assignment stopped taking new students: the earlier of the hand close and the closing
// time, as on the server. Null while neither has been set, i.e. while it is open for good.
function effectiveClose(assignment: Assignment): Date | null {
  const times = [assignment.closedAt, assignment.closesAt]
    .filter((time): time is string => time !== null)
    .map(time => new Date(time).getTime());
  return times.length === 0 ? null : new Date(Math.min(...times));
}

// Whether the leaderboard can still change: while the assignment is open, and for the grace period after it
// closed, when the browsers of students in the middle of a stage still report their result.
export function shouldPoll(assignment: Assignment, now: Date): boolean {
  if (isOpenAt(assignment, now)) {
    return true;
  }
  const close = effectiveClose(assignment);
  return close !== null && now.getTime() < close.getTime() + RESULT_GRACE_MS;
}

// The name of the downloaded leaderboard: '<title>[-<label>]-bang-xep-hang.csv'. Characters a file system
// rejects are dropped and spaces become dashes, the way the quiz files are named. A title like 'HSK1 - Bài 5'
// would otherwise give 'HSK1---Bài-5', so runs of dashes collapse to one.
export function fileNameFor(detail: Pick<AssignmentDetail, 'title' | 'label'>): string {
  const clean = (text: string) => text.replace(/\s+/g, ' ').replace(/[\\/:*?"<>|]|\p{Cc}/gu, '').trim()
    .replace(/ +/g, '-').replace(/-{2,}/g, '-');
  const parts = [clean(detail.title), clean(detail.label)].filter(part => part !== '');
  return `${parts.length > 0 ? parts.join('-') : 'QuizTool'}-bang-xep-hang.csv`;
}

// What a rank badge shows: a medal for the first three places, the number after them and a dash for a
// student who has no result yet. Students tied on a place share its medal.
export function medal(rank: number | null): string {
  switch (rank) {
    case null:
      return '–';
    case 1:
      return '🥇';
    case 2:
      return '🥈';
    case 3:
      return '🥉';
    default:
      return String(rank);
  }
}

// What a stage shows for a student: the best run ('4/5', with a check mark once passed), or null when the
// student has not played the stage.
export function stageCell(player: LeaderboardEntry, stage: string | number): { text: string; passed: boolean } | null {
  const score = player.stages[String(stage)];
  if (!score) {
    return null;
  }
  return {
    text: `${score.correct}/${score.total}${score.passed ? ' ✓' : ''}`,
    passed: score.passed
  };
}

// The part of a stage column a pip needs: its key (the stage's number), its position among the assignment's
// stages and the game's name and icon.
export interface PipStage {
  key: string;
  position: number;
  icon: string;
  name: string;
}

// One stage of one student's row. `state` is 'passed' (best run reached the pass mark), 'played' (played, not
// passed) or 'none'; `text` is the best run for a played stage and a dash for the others; `title` says it in
// words: 'Màn 2 · Nghiêng đầu: 4/5 ✓ · 3 lần'.
export interface StagePip {
  key: string;
  icon: string;
  text: string;
  state: 'passed' | 'played' | 'none';
  title: string;
}

export function stagePip(player: LeaderboardEntry, stage: PipStage): StagePip {
  const cell = stageCell(player, stage.key);
  const head = `Màn ${stage.position} · ${stage.name}`;
  if (cell === null) {
    return {
      key: stage.key,
      icon: stage.icon,
      text: '–',
      state: 'none',
      title: `${head}: chưa chơi`
    };
  }
  const attempts = player.stages[stage.key].attempts;
  return {
    key: stage.key,
    icon: stage.icon,
    text: cell.text,
    state: cell.passed ? 'passed' : 'played',
    title: `${head}: ${cell.text} · ${attempts} lần`,
  };
}

// How much of the possible answers a student got right, as a percentage for the score's bar (0 when the quiz
// has no question).
export function scorePercent(player: Pick<LeaderboardEntry, 'correct' | 'possible'>): number {
  return player.possible > 0 ? Math.min(100, Math.round((player.correct / player.possible) * 100)) : 0;
}

// How long a change of place stays on the board.
export const MOVE_KEEP_MS = 30_000;

// A student's change of place the last time it changed: `delta` places gained (negative: lost), `at` the
// time it was seen (ms since the epoch).
export interface RankMove {
  delta: number;
  at: number;
}

// The moves to show after a new answer. A move is recorded for a student who had a place in the previous
// answer and has a different one now (places are compared, not positions in the list, so a tie breaking
// moves exactly the students whose place changed). A move recorded earlier is kept for `keepMs`, so it
// outlives the answers in which the student stays put; a newer change replaces it. A student who is new, has
// no place yet or is gone has no move, and `previous` is null for the first answer of a page, which has
// nothing to compare with.
export function rankMoves(
  previous: readonly LeaderboardEntry[] | null,
  next: readonly LeaderboardEntry[],
  previousMoves: ReadonlyMap<string, RankMove>,
  now: number,
  keepMs = MOVE_KEEP_MS,
): Map<string, RankMove> {
  const before = new Map((previous ?? []).map(player => [player.id, player.rank]));
  const moves = new Map<string, RankMove>();
  for (const player of next) {
    if (player.rank === null) {
      continue;
    }
    const was = before.get(player.id);
    if (was !== undefined && was !== null && was !== player.rank) {
      moves.set(player.id, {
        delta: was - player.rank,
        at: now
      });
      continue;
    }
    const kept = previousMoves.get(player.id);
    if (kept !== undefined && now - kept.at < keepMs) {
      moves.set(player.id, kept);
    }
  }
  return moves;
}

// A move as the row shows it: '▲2' (gained two places) or '▼1', with the words for assistive technology, or
// null once it is older than `showMs` (or there is none).
export interface MoveMark {
  text: string;
  label: string;
  up: boolean;
}

export function moveMark(move: RankMove | undefined, now: number, showMs = MOVE_KEEP_MS): MoveMark | null {
  if (move === undefined || move.delta === 0 || now - move.at >= showMs) {
    return null;
  }
  const places = Math.abs(move.delta);
  return move.delta > 0
    ? {
      text: `▲${places}`,
      label: `Lên ${places} hạng`,
      up: true
    }
    : {
      text: `▼${places}`,
      label: `Xuống ${places} hạng`,
      up: false
    };
}

// Whether two answers list the students in a different order (or different students): the rows then move,
// and the page animates them.
export function orderChanged(previous: readonly LeaderboardEntry[], next: readonly LeaderboardEntry[]): boolean {
  return previous.length !== next.length || previous.some((player, index) => player.id !== next[index].id);
}
