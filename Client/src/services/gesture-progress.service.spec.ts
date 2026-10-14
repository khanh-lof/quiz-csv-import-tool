import { passMark } from '../game/stages';
import { GestureQuiz } from '../models/gesture-quiz';
import { GestureProgressService, POINTS_PER_CORRECT } from './gesture-progress.service';

const STORAGE_KEY = 'gesture-quiz-progress';

// A quiz with one question in each of the given stages: the progress only looks at which stages exist.
function quizWith(stages: number[], key = 'quiz-a'): GestureQuiz {
  return {
    title: 'Quiz',
    key,
    stages: new Map(
      stages.map(stage => [stage, [{ stage, question: 'Q', correct: 'A', wrong: [], explanation: '' }]]),
    ),
    skipped: 0,
  };
}

describe('GestureProgressService', () => {
  let service: GestureProgressService;

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    service = new GestureProgressService();
  });

  afterEach(() => localStorage.removeItem(STORAGE_KEY));

  describe('unlocking', () => {
    it('opens stage 1 and nothing else on a fresh quiz', () => {
      const quiz = quizWith([1, 2, 3, 4, 5, 6]);

      expect(service.isUnlocked(quiz, 1)).toBeTrue();
      for (const stage of [2, 3, 4, 5, 6]) {
        expect(service.isUnlocked(quiz, stage)).toBeFalse();
      }
    });

    it('opens each stage once the one before it is passed', () => {
      const quiz = quizWith([1, 2, 3, 4, 5, 6]);

      service.record(quiz.key, 1, 5, 5);
      expect(service.isUnlocked(quiz, 2)).toBeTrue();
      expect(service.isUnlocked(quiz, 3)).toBeFalse();

      service.record(quiz.key, 2, 4, 5);
      expect(service.isUnlocked(quiz, 3)).toBeTrue();
    });

    it('does not open a stage when only the one before it was failed', () => {
      const quiz = quizWith([1, 2]);

      service.record(quiz.key, 1, 3, 5);

      expect(service.isUnlocked(quiz, 2)).toBeFalse();
    });

    it('skips stages that have no questions in the quiz', () => {
      const quiz = quizWith([1, 4, 6]);

      expect(service.isUnlocked(quiz, 4)).toBeFalse();
      service.record(quiz.key, 1, 5, 5);
      expect(service.isUnlocked(quiz, 4)).toBeTrue();
      expect(service.isUnlocked(quiz, 6)).toBeFalse();
      service.record(quiz.key, 4, 5, 5);
      expect(service.isUnlocked(quiz, 6)).toBeTrue();
    });

    it('opens the first stage that has questions when the earlier ones are empty', () => {
      const quiz = quizWith([3, 5]);

      expect(service.isUnlocked(quiz, 3)).toBeTrue();
      expect(service.isUnlocked(quiz, 5)).toBeFalse();
    });
  });

  describe('pass mark', () => {
    it('passes at 4 of 5 and fails at 3 of 5', () => {
      expect(passMark(5)).toBe(4);
      expect(service.record('k', 1, 4, 5)).toBeTrue();
      expect(service.record('k', 2, 3, 5)).toBeFalse();
      expect(service.isPassed('k', 1)).toBeTrue();
      expect(service.isPassed('k', 2)).toBeFalse();
    });

    it('passes at 3 of 4 and fails at 2 of 4', () => {
      expect(passMark(4)).toBe(3);
      expect(service.record('k', 1, 3, 4)).toBeTrue();
      expect(service.record('k', 2, 2, 4)).toBeFalse();
    });
  });

  describe('best result', () => {
    it('is empty before a stage is played', () => {
      expect(service.best('k', 1)).toBeNull();
    });

    it('keeps the best run, not the latest', () => {
      service.record('k', 1, 3, 5);
      expect(service.best('k', 1)).toEqual({ correct: 3, total: 5 });

      service.record('k', 1, 5, 5);
      expect(service.best('k', 1)).toEqual({ correct: 5, total: 5 });

      service.record('k', 1, 2, 5);
      expect(service.best('k', 1)).toEqual({ correct: 5, total: 5 });
    });

    it('is kept apart per stage and per quiz', () => {
      service.record('a', 1, 5, 5);
      service.record('b', 1, 2, 5);
      service.record('a', 2, 1, 4);

      expect(service.best('a', 1)).toEqual({ correct: 5, total: 5 });
      expect(service.best('b', 1)).toEqual({ correct: 2, total: 5 });
      expect(service.best('a', 2)).toEqual({ correct: 1, total: 4 });
      expect(service.best('b', 2)).toBeNull();
    });

    it('scores a right answer at 10 points', () => {
      expect(POINTS_PER_CORRECT).toBe(10);
    });
  });

  it('never un-passes a stage that a later run failed', () => {
    service.record('k', 1, 5, 5);

    expect(service.record('k', 1, 1, 5)).toBeFalse();

    expect(service.isPassed('k', 1)).toBeTrue();
    expect(service.best('k', 1)).toEqual({ correct: 5, total: 5 });
  });

  it('shows a change through the same instance at once', () => {
    const quiz = quizWith([1, 2]);

    service.record(quiz.key, 1, 5, 5);

    expect(service.isPassed(quiz.key, 1)).toBeTrue();
    expect(service.isUnlocked(quiz, 2)).toBeTrue();
  });

  it('persists across service instances', () => {
    service.record('k', 1, 4, 5);
    service.record('k', 2, 2, 5);

    const reopened = new GestureProgressService();

    expect(reopened.isPassed('k', 1)).toBeTrue();
    expect(reopened.isPassed('k', 2)).toBeFalse();
    expect(reopened.best('k', 1)).toEqual({ correct: 4, total: 5 });
    expect(reopened.best('k', 2)).toEqual({ correct: 2, total: 5 });
  });

  it('keeps another instance\'s progress when it records on top of an older copy', () => {
    const other = new GestureProgressService();
    service.record('k', 1, 5, 5);

    other.record('k', 2, 5, 5);

    const reopened = new GestureProgressService();
    expect(reopened.isPassed('k', 1)).toBeTrue();
    expect(reopened.isPassed('k', 2)).toBeTrue();
  });

  describe('corrupt storage', () => {
    it('treats text that is not JSON as empty and carries on', () => {
      localStorage.setItem(STORAGE_KEY, '{not json');
      const corrupt = new GestureProgressService();

      expect(corrupt.isPassed('k', 1)).toBeFalse();
      expect(corrupt.best('k', 1)).toBeNull();
      expect(corrupt.record('k', 1, 5, 5)).toBeTrue();
      expect(new GestureProgressService().isPassed('k', 1)).toBeTrue();
    });

    it('treats a value of the wrong shape as empty', () => {
      for (const value of ['[]', '"text"', '42', 'null', '{"k": 7}', '{"k": {"passed": "x", "best": []}}']) {
        localStorage.setItem(STORAGE_KEY, value);
        const corrupt = new GestureProgressService();

        expect(corrupt.isPassed('k', 1)).withContext(value).toBeFalse();
        expect(corrupt.best('k', 1)).withContext(value).toBeNull();
      }
    });

    it('drops only the entries that are broken', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          k: { passed: [1, 'x', 99], best: { 1: { correct: 5, total: 5 }, 2: { correct: 'a' }, 9: { correct: 1, total: 1 } } },
        }),
      );
      const partial = new GestureProgressService();

      expect(partial.isPassed('k', 1)).toBeTrue();
      expect(partial.isPassed('k', 99)).toBeFalse();
      expect(partial.best('k', 1)).toEqual({ correct: 5, total: 5 });
      expect(partial.best('k', 2)).toBeNull();
      expect(partial.best('k', 9)).toBeNull();
    });
  });

  describe('reset', () => {
    it('forgets one quiz and leaves the others', () => {
      const quiz = quizWith([1, 2], 'a');
      service.record('a', 1, 5, 5);
      service.record('b', 1, 5, 5);

      service.reset('a');

      expect(service.isPassed('a', 1)).toBeFalse();
      expect(service.best('a', 1)).toBeNull();
      expect(service.isUnlocked(quiz, 2)).toBeFalse();
      expect(service.isPassed('b', 1)).toBeTrue();
      expect(new GestureProgressService().isPassed('a', 1)).toBeFalse();
      expect(new GestureProgressService().isPassed('b', 1)).toBeTrue();
    });

    it('does nothing for a quiz without progress', () => {
      expect(() => service.reset('unknown')).not.toThrow();
    });
  });

  it('plays on without saving when storage is unavailable', () => {
    const setItem = spyOn(Storage.prototype, 'setItem').and.throwError('blocked');
    const getItem = spyOn(Storage.prototype, 'getItem').and.throwError('blocked');

    expect(service.record('k', 1, 5, 5)).toBeTrue();
    expect(service.isPassed('k', 1)).toBeTrue();
    expect(setItem).toHaveBeenCalled();
    expect(getItem).toHaveBeenCalled();
  });
});
