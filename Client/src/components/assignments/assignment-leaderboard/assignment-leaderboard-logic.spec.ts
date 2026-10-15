import { Assignment, LeaderboardEntry } from '../../../models/assignment';
import {
  fileNameFor,
  medal,
  MOVE_KEEP_MS,
  moveMark,
  orderChanged,
  RankMove,
  rankMoves,
  RESULT_GRACE_MS,
  scorePercent,
  shouldPoll,
  stageCell,
  stagePip,
} from './assignment-leaderboard-logic';

const NOW = new Date(2026, 9, 14, 10, 0, 0);

function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

const MINUTE = 60 * 1000;

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: 'a1', code: 'K7M2X9QD4P', jobId: 'job-1', title: 'HSK1 bài 1', label: '', timeMode: 'standard', stageLock: 'sequential',
    passPercents: {'1': 70, '2': 70}, maxAttempts: null, stageCounts: {'1': 5, '2': 5}, createdAt: at(-60 * MINUTE), closesAt: null, closedAt: null,
    open: true, playerCount: 0, ...overrides,
  };
}

function player(stages: LeaderboardEntry['stages']): LeaderboardEntry {
  return {
    id: 'p1', name: 'Lan', avatar: 'cat', rank: 1, stagesPassed: 1, correct: 9, possible: 10, attempts: 2, stages,
    joinedAt: at(-30 * MINUTE), lastPlayedAt: at(-5 * MINUTE), reachedAt: at(-5 * MINUTE),
  };
}

// A student with an id and a rank (null for none), for the moves.
function ranked(id: string, rank: number | null): LeaderboardEntry {
  return {...player({}), id, name: id, rank};
}

describe('shouldPoll', () => {
  it('polls while the assignment is open for good', () => {
    expect(shouldPoll(assignment(), NOW)).toBeTrue();
  });

  it('polls while it is open until a closing time that has not come', () => {
    expect(shouldPoll(assignment({closesAt: at(MINUTE)}), NOW)).toBeTrue();
  });

  it('keeps polling for the grace period after the closing time passed', () => {
    expect(shouldPoll(assignment({closesAt: at(-2 * MINUTE)}), NOW)).toBeTrue();
  });

  it('stops once the grace period after the closing time is over', () => {
    expect(shouldPoll(assignment({closesAt: at(-6 * MINUTE)}), NOW)).toBeFalse();
  });

  it('keeps polling for the grace period after a hand close, then stops', () => {
    expect(shouldPoll(assignment({closedAt: at(-MINUTE)}), NOW)).toBeTrue();
    expect(shouldPoll(assignment({closedAt: at(-10 * MINUTE)}), NOW)).toBeFalse();
  });

  it('does not poll at the very end of the grace period', () => {
    expect(shouldPoll(assignment({closedAt: at(-RESULT_GRACE_MS)}), NOW)).toBeFalse();
    expect(shouldPoll(assignment({closedAt: at(-RESULT_GRACE_MS + 1)}), NOW)).toBeTrue();
  });

  it('counts the grace from the earlier of the hand close and the closing time', () => {
    // The closing time passed 8 minutes ago; the hand close came 1 minute ago, which does not reopen the grace.
    expect(shouldPoll(assignment({closesAt: at(-8 * MINUTE), closedAt: at(-MINUTE)}), NOW)).toBeFalse();
    // Closed by hand 2 minutes ago, well before a closing time that has not come.
    expect(shouldPoll(assignment({closesAt: at(60 * MINUTE), closedAt: at(-2 * MINUTE)}), NOW)).toBeTrue();
  });
});

describe('fileNameFor', () => {
  it('names the file after the title, with spaces as dashes', () => {
    expect(fileNameFor(assignment({title: 'HSK1 bài 1'}))).toBe('HSK1-bài-1-bang-xep-hang.csv');
  });

  it('puts the label after the title', () => {
    expect(fileNameFor(assignment({title: 'HSK1 bài 1', label: 'Lớp 6A  tối'}))).toBe('HSK1-bài-1-Lớp-6A-tối-bang-xep-hang.csv');
  });

  it('drops the characters a file system rejects', () => {
    expect(fileNameFor(assignment({title: 'Bài 1: "Xin chào"?', label: '6/A <sáng>'})))
      .toBe('Bài-1-Xin-chào-6A-sáng-bang-xep-hang.csv');
  });

  it('treats a line break as a space and trims the ends', () => {
    expect(fileNameFor(assignment({title: '  Bài\n1\t', label: ' '}))).toBe('Bài-1-bang-xep-hang.csv');
  });

  it('does not repeat dashes around a dash in the title', () => {
    expect(fileNameFor(assignment({title: 'HSK1 - Quiz mẫu', label: 'Lớp 3A'}))).toBe('HSK1-Quiz-mẫu-Lớp-3A-bang-xep-hang.csv');
  });

  it('falls back to QuizTool when nothing is left of the title and the label', () => {
    expect(fileNameFor(assignment({title: '???', label: ''}))).toBe('QuizTool-bang-xep-hang.csv');
  });
});

describe('stageCell', () => {
  const lan = player({
    '1': {correct: 5, total: 5, passed: true, attempts: 1},
    '2': {correct: 3, total: 5, passed: false, attempts: 2},
  });

  it('shows the best run with a check mark for a passed stage', () => {
    expect(stageCell(lan, '1')).toEqual({text: '5/5 ✓', passed: true});
  });

  it('shows the best run without a check mark for a stage not passed yet', () => {
    expect(stageCell(lan, '2')).toEqual({text: '3/5', passed: false});
  });

  it('is null for a stage the student has not played', () => {
    expect(stageCell(lan, '3')).toBeNull();
  });

  it('accepts the stage as a number', () => {
    expect(stageCell(lan, 1)).toEqual({text: '5/5 ✓', passed: true});
  });
});

describe('stagePip', () => {
  const lan = player({
    '1': {correct: 5, total: 5, passed: true, attempts: 1},
    '2': {correct: 4, total: 5, passed: false, attempts: 3},
  });
  const stage1 = {key: '1', position: 1, icon: '👍', name: 'Đúng hay sai'};
  const stage2 = {key: '2', position: 2, icon: '🙆', name: 'Nghiêng đầu'};

  it('shows a passed stage with its check mark and says how many runs it took', () => {
    expect(stagePip(lan, stage1)).toEqual({
      key: '1', icon: '👍', text: '5/5 ✓', state: 'passed', title: 'Màn 1 · Đúng hay sai: 5/5 ✓ · 1 lần',
    });
  });

  it('shows a played stage that is not passed without the check mark', () => {
    expect(stagePip(lan, stage2)).toEqual({
      key: '2', icon: '🙆', text: '4/5', state: 'played', title: 'Màn 2 · Nghiêng đầu: 4/5 · 3 lần',
    });
  });

  it('shows a dash for a stage not played, and says so in the title', () => {
    expect(stagePip(lan, {key: '3', position: 3, icon: '🐸', name: 'Ếch đớp chữ'})).toEqual({
      key: '3', icon: '🐸', text: '–', state: 'none', title: 'Màn 3 · Ếch đớp chữ: chưa chơi',
    });
  });

  it("names the stage by its position among the assignment's stages, not by its number", () => {
    const stage4 = {key: '4', position: 1, icon: '🍉', name: 'Chém hoa quả'};
    const score = player({'4': {correct: 3, total: 5, passed: false, attempts: 2}});
    expect(stagePip(score, stage4).title).toBe('Màn 1 · Chém hoa quả: 3/5 · 2 lần');
  });
});

describe('scorePercent', () => {
  it('is the share of the possible answers got right, rounded', () => {
    expect(scorePercent({correct: 7, possible: 10})).toBe(70);
    expect(scorePercent({correct: 1, possible: 3})).toBe(33);
    expect(scorePercent({correct: 10, possible: 10})).toBe(100);
  });

  it('is 0 when nothing is right or nothing is possible', () => {
    expect(scorePercent({correct: 0, possible: 10})).toBe(0);
    expect(scorePercent({correct: 0, possible: 0})).toBe(0);
  });
});

describe('medal', () => {
  it('gives a medal to each of the first three places', () => {
    expect([medal(1), medal(2), medal(3)]).toEqual(['🥇', '🥈', '🥉']);
  });

  it('gives the number to the places after them', () => {
    expect(medal(4)).toBe('4');
    expect(medal(12)).toBe('12');
  });

  it('gives a dash to a student without a result', () => {
    expect(medal(null)).toBe('–');
  });
});

describe('rankMoves', () => {
  const NOW_MS = NOW.getTime();
  const none = new Map<string, RankMove>();

  it('records a move up as a positive delta, with the time it was seen', () => {
    const moves = rankMoves([ranked('a', 1), ranked('b', 2)], [ranked('b', 1), ranked('a', 2)], none, NOW_MS);

    expect(moves.get('b')).toEqual({delta: 1, at: NOW_MS});
  });

  it('records a move down as a negative delta', () => {
    const moves = rankMoves([ranked('a', 1), ranked('b', 2)], [ranked('b', 1), ranked('a', 2)], none, NOW_MS);

    expect(moves.get('a')).toEqual({delta: -1, at: NOW_MS});
  });

  it('counts every place gained, not the positions in the list', () => {
    const before = [ranked('a', 1), ranked('b', 2), ranked('c', 3), ranked('d', 4)];
    const after = [ranked('d', 1), ranked('a', 2), ranked('b', 3), ranked('c', 4)];

    const moves = rankMoves(before, after, none, NOW_MS);

    expect(moves.get('d')?.delta).toBe(3);
    expect(moves.get('a')?.delta).toBe(-1);
  });

  it('compares ranks, so students who keep a shared rank have no move when the list is reordered', () => {
    const moves = rankMoves([ranked('a', 1), ranked('b', 1)], [ranked('b', 1), ranked('a', 1)], none, NOW_MS);

    expect(moves.size).toBe(0);
  });

  it('records no move for a student whose rank did not change', () => {
    expect(rankMoves([ranked('a', 1), ranked('b', 2)], [ranked('a', 1), ranked('b', 2)], none, NOW_MS).size).toBe(0);
  });

  it('records no move for a student who is new', () => {
    const moves = rankMoves([ranked('a', 1)], [ranked('a', 1), ranked('b', 2)], none, NOW_MS);

    expect(moves.has('b')).toBeFalse();
  });

  it('records no move for the first answer, which has nothing before it', () => {
    expect(rankMoves(null, [ranked('a', 1), ranked('b', 2)], none, NOW_MS).size).toBe(0);
  });

  it('records no move for a student who had no rank and has one now', () => {
    const moves = rankMoves([ranked('a', 1), ranked('b', null)], [ranked('a', 1), ranked('b', 2)], none, NOW_MS);

    expect(moves.has('b')).toBeFalse();
  });

  it('records no move for a student who has no rank now, and forgets an older one', () => {
    const older = new Map([['b', {delta: 2, at: NOW_MS - 1000}]]);

    const moves = rankMoves([ranked('b', 1)], [ranked('b', null)], older, NOW_MS);

    expect(moves.has('b')).toBeFalse();
  });

  it('forgets the move of a student who is gone', () => {
    const older = new Map([['b', {delta: 2, at: NOW_MS - 1000}]]);

    const moves = rankMoves([ranked('a', 1), ranked('b', 2)], [ranked('a', 1)], older, NOW_MS);

    expect(moves.size).toBe(0);
  });

  it('keeps an older move while the student stays put, until it is 30 seconds old', () => {
    const older = new Map([['b', {delta: 2, at: NOW_MS - 10_000}]]);
    const same = [ranked('a', 1), ranked('b', 2)];

    expect(rankMoves(same, same, older, NOW_MS).get('b')).toEqual({delta: 2, at: NOW_MS - 10_000});
    expect(rankMoves(same, same, older, NOW_MS + MOVE_KEEP_MS - 10_001).has('b')).toBeTrue();
    expect(rankMoves(same, same, older, NOW_MS + MOVE_KEEP_MS - 10_000).has('b')).toBeFalse();
  });

  it('lets the time to keep a move be given', () => {
    const older = new Map([['b', {delta: 1, at: NOW_MS - 3000}]]);
    const same = [ranked('b', 2)];

    expect(rankMoves(same, same, older, NOW_MS, 5000).has('b')).toBeTrue();
    expect(rankMoves(same, same, older, NOW_MS, 3000).has('b')).toBeFalse();
  });

  it('replaces an older move with a newer change of place', () => {
    const older = new Map([['a', {delta: 2, at: NOW_MS - 5000}]]);

    const moves = rankMoves([ranked('a', 1), ranked('b', 2)], [ranked('b', 1), ranked('a', 2)], older, NOW_MS);

    expect(moves.get('a')).toEqual({delta: -1, at: NOW_MS});
  });

  it('does not change the moves it was given', () => {
    const older = new Map([['b', {delta: 2, at: NOW_MS - 1000}]]);

    rankMoves([ranked('b', 1)], [ranked('b', null)], older, NOW_MS);

    expect(older.size).toBe(1);
  });
});

describe('moveMark', () => {
  const NOW_MS = NOW.getTime();

  it('shows a move up as an up arrow and the number of places, with the words for a screen reader', () => {
    expect(moveMark({delta: 2, at: NOW_MS}, NOW_MS)).toEqual({text: '▲2', label: 'Lên 2 hạng', up: true});
  });

  it('shows a move down as a down arrow and the number of places', () => {
    expect(moveMark({delta: -1, at: NOW_MS}, NOW_MS)).toEqual({text: '▼1', label: 'Xuống 1 hạng', up: false});
  });

  it('shows nothing without a move', () => {
    expect(moveMark(undefined, NOW_MS)).toBeNull();
  });

  it('shows a move for 30 seconds', () => {
    expect(moveMark({delta: 1, at: NOW_MS - MOVE_KEEP_MS + 1}, NOW_MS)).not.toBeNull();
    expect(moveMark({delta: 1, at: NOW_MS - MOVE_KEEP_MS}, NOW_MS)).toBeNull();
  });
});

describe('orderChanged', () => {
  it('is false for the same students in the same order, whatever else changed', () => {
    expect(orderChanged([ranked('a', 1), ranked('b', 2)], [{...ranked('a', 1), correct: 3}, ranked('b', 2)])).toBeFalse();
  });

  it('is true when two students swap', () => {
    expect(orderChanged([ranked('a', 1), ranked('b', 2)], [ranked('b', 1), ranked('a', 2)])).toBeTrue();
  });

  it('is true when a student joins or is removed', () => {
    expect(orderChanged([ranked('a', 1)], [ranked('a', 1), ranked('b', null)])).toBeTrue();
    expect(orderChanged([ranked('a', 1), ranked('b', 2)], [ranked('b', 1)])).toBeTrue();
  });
});
