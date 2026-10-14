import { Assignment, RankedPlayer } from '../../../models/assignment';
import { fileNameFor, medal, RESULT_GRACE_MS, shouldPoll, stageCell } from './assignment-ranking-logic';

const NOW = new Date(2026, 9, 14, 10, 0, 0);

function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

const MINUTE = 60 * 1000;

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: 'a1', code: 'K7M2X9QD4P', jobId: 'job-1', title: 'HSK1 bài 1', label: '', timeMode: 'standard',
    stageCounts: {'1': 5, '2': 5}, createdAt: at(-60 * MINUTE), closesAt: null, closedAt: null,
    open: true, playerCount: 0, ...overrides,
  };
}

function player(stages: RankedPlayer['stages']): RankedPlayer {
  return {
    id: 'p1', name: 'Lan', rank: 1, stagesPassed: 1, correct: 9, possible: 10, attempts: 2, stages,
    joinedAt: at(-30 * MINUTE), lastPlayedAt: at(-5 * MINUTE), reachedAt: at(-5 * MINUTE),
  };
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
