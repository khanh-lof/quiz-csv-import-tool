import { Assignment, AssignmentDetail, isOpenAt, RankedPlayer } from '../../../models/assignment';

// How long after the close a student's result is still accepted (the server's grace period), so how long
// the ranking keeps changing and is worth refreshing by itself.
export const RESULT_GRACE_MS = 5 * 60 * 1000;

// The moment the assignment stopped taking new students: the earlier of the hand close and the closing
// time, as on the server. Null while neither has been set, i.e. while it is open for good.
function effectiveClose(assignment: Assignment): Date | null {
  const times = [assignment.closedAt, assignment.closesAt]
    .filter((time): time is string => time !== null)
    .map(time => new Date(time).getTime());
  return times.length === 0 ? null : new Date(Math.min(...times));
}

// Whether the ranking can still change: while the assignment is open, and for the grace period after it
// closed, when the browsers of students in the middle of a stage still report their result.
export function shouldPoll(assignment: Assignment, now: Date): boolean {
  if (isOpenAt(assignment, now)) {
    return true;
  }
  const close = effectiveClose(assignment);
  return close !== null && now.getTime() < close.getTime() + RESULT_GRACE_MS;
}

// The name of the downloaded ranking: '<title>[-<label>]-bang-xep-hang.csv'. Characters a file system
// rejects are dropped and spaces become dashes, the way the quiz files are named. A title like 'HSK1 - Bài 5'
// would otherwise give 'HSK1---Bài-5', so runs of dashes collapse to one.
export function fileNameFor(detail: Pick<AssignmentDetail, 'title' | 'label'>): string {
  const clean = (text: string) => text.replace(/\s+/g, ' ').replace(/[\\/:*?"<>|]|\p{Cc}/gu, '').trim()
    .replace(/ +/g, '-').replace(/-{2,}/g, '-');
  const parts = [clean(detail.title), clean(detail.label)].filter(part => part !== '');
  return `${parts.length > 0 ? parts.join('-') : 'QuizTool'}-bang-xep-hang.csv`;
}

// What the "Hạng" column shows: a medal for the first three places, the number after them and a dash for a
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

// What a stage column shows for a student: the best run ('4/5', with a check mark once passed), or null
// when the student has not played the stage.
export function stageCell(player: RankedPlayer, stage: string | number): { text: string; passed: boolean } | null {
  const score = player.stages[String(stage)];
  if (!score) {
    return null;
  }
  return {text: `${score.correct}/${score.total}${score.passed ? ' ✓' : ''}`, passed: score.passed};
}
