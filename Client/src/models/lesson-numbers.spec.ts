import { formatLessonNumbers, lessonNumbersOf, MAX_LESSONS } from './lesson-numbers';

describe('lesson numbers', () => {
  it('keeps the limit the server enforces', () => {
    expect(MAX_LESSONS).toBe(5);
  });

  describe('formatLessonNumbers', () => {
    it('writes a single lesson as its number', () => {
      expect(formatLessonNumbers([5])).toBe('5');
    });

    it('lists two consecutive lessons one by one', () => {
      expect(formatLessonNumbers([3, 4])).toBe('3, 4');
    });

    it('lists lessons that are not consecutive one by one', () => {
      expect(formatLessonNumbers([1, 3, 5])).toBe('1, 3, 5');
    });

    it('writes a run of three or more as first to last', () => {
      expect(formatLessonNumbers([3, 4, 5])).toBe('3–5');
      expect(formatLessonNumbers([1, 2, 3, 4, 5])).toBe('1–5');
      expect(formatLessonNumbers([3, 4, 5, 7])).toBe('3–5, 7');
      expect(formatLessonNumbers([1, 3, 4, 5, 8, 9])).toBe('1, 3–5, 8, 9');
    });

    it('sorts first', () => {
      expect(formatLessonNumbers([7, 5, 3, 4])).toBe('3–5, 7');
    });

    it('takes the range and separator of a file name', () => {
      expect(formatLessonNumbers([3, 4, 5, 7], '-', '+')).toBe('3-5+7');
      expect(formatLessonNumbers([2, 4], '-', '+')).toBe('2+4');
    });

    it('gives nothing for no lessons', () => {
      expect(formatLessonNumbers([])).toBe('');
    });

    it('does not change the list it is given', () => {
      const lessons = [5, 3, 4];
      formatLessonNumbers(lessons);
      expect(lessons).toEqual([5, 3, 4]);
    });
  });

  describe('lessonNumbersOf', () => {
    it('keeps a valid choice as it is', () => {
      expect(lessonNumbersOf([3, 4, 5])).toEqual([3, 4, 5]);
      expect(lessonNumbersOf([7])).toEqual([7]);
    });

    it('sorts the lessons and drops repeats', () => {
      expect(lessonNumbersOf([5, 2, 5, 3, 2])).toEqual([2, 3, 5]);
    });

    it('drops what is not a lesson number and keeps the rest', () => {
      expect(lessonNumbersOf([0, 2, -1, 2.5, '3', null, NaN, Infinity, 4, {}, true])).toEqual([2, 4]);
    });

    it('keeps the first lessons after sorting when there are too many', () => {
      expect(lessonNumbersOf([9, 8, 7, 6, 5, 4, 3])).toEqual([3, 4, 5, 6, 7]);
    });

    it('gives nothing when nothing usable is left', () => {
      expect(lessonNumbersOf(undefined)).toEqual([]);
      expect(lessonNumbersOf([])).toEqual([]);
      expect(lessonNumbersOf([0, 'x'])).toEqual([]);
    });

    it('gives nothing for a value that is not a list', () => {
      for (const value of [null, 3, '1,2', {}, true]) {
        expect(lessonNumbersOf(value)).toEqual([]);
      }
    });

    it('does not change the list it is given', () => {
      const saved = [5, 1, 5];
      lessonNumbersOf(saved);
      expect(saved).toEqual([5, 1, 5]);
    });
  });
});
