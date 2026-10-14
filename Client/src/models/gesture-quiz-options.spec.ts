import {
  ALL_GESTURE_STAGES,
  gestureStagesOf,
  QUESTIONS_PER_STAGE_DEFAULT,
  QUESTIONS_PER_STAGE_MAX,
  QUESTIONS_PER_STAGE_MIN,
  questionsPerStageOf
} from './gesture-quiz-options';
import { STAGES } from '../game/stages';

describe('gesture quiz options', () => {
  it('keeps the limits the server enforces', () => {
    expect(QUESTIONS_PER_STAGE_MIN).toBe(4);
    expect(QUESTIONS_PER_STAGE_MAX).toBe(10);
    expect(QUESTIONS_PER_STAGE_DEFAULT).toBe(5);
  });

  it('offers every stage of the game, easiest first', () => {
    expect([...ALL_GESTURE_STAGES]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...ALL_GESTURE_STAGES]).toEqual(STAGES.map(def => def.stage));
  });

  describe('gestureStagesOf', () => {
    it('keeps a valid choice as it is', () => {
      expect(gestureStagesOf([1, 3, 5])).toEqual([1, 3, 5]);
      expect(gestureStagesOf([4])).toEqual([4]);
      expect(gestureStagesOf([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('sorts the stages and drops repeats', () => {
      expect(gestureStagesOf([6, 2, 6, 4, 2])).toEqual([2, 4, 6]);
    });

    it('drops what is not a stage number and keeps the rest', () => {
      expect(gestureStagesOf([0, 2, 7, 2.5, '3', null, NaN, -1, 5, {}, true])).toEqual([2, 5]);
    });

    it('gives every stage when nothing usable is left', () => {
      expect(gestureStagesOf([])).toEqual([1, 2, 3, 4, 5, 6]);
      expect(gestureStagesOf([0, 7, 'x', null])).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('gives every stage for a value that is not a list', () => {
      for (const value of [undefined, null, 3, '1,2', {}, true]) {
        expect(gestureStagesOf(value)).toEqual([1, 2, 3, 4, 5, 6]);
      }
    });

    it('hands out a copy, so a caller cannot change the shared list', () => {
      const first = gestureStagesOf(undefined);
      first.pop();
      expect(gestureStagesOf(undefined)).toEqual([1, 2, 3, 4, 5, 6]);
      expect([...ALL_GESTURE_STAGES]).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('does not change the list it is given', () => {
      const saved = [5, 1, 5];
      gestureStagesOf(saved);
      expect(saved).toEqual([5, 1, 5]);
    });
  });

  describe('questionsPerStageOf', () => {
    it('keeps an integer within the range', () => {
      for (let count = QUESTIONS_PER_STAGE_MIN; count <= QUESTIONS_PER_STAGE_MAX; count++) {
        expect(questionsPerStageOf(count)).toBe(count);
      }
    });

    it('gives the default outside the range', () => {
      expect(questionsPerStageOf(3)).toBe(QUESTIONS_PER_STAGE_DEFAULT);
      expect(questionsPerStageOf(11)).toBe(QUESTIONS_PER_STAGE_DEFAULT);
      expect(questionsPerStageOf(0)).toBe(QUESTIONS_PER_STAGE_DEFAULT);
      expect(questionsPerStageOf(-6)).toBe(QUESTIONS_PER_STAGE_DEFAULT);
    });

    it('gives the default for what is not an integer', () => {
      for (const value of [4.5, NaN, Infinity, '7', null, undefined, [], {}, true]) {
        expect(questionsPerStageOf(value)).toBe(QUESTIONS_PER_STAGE_DEFAULT);
      }
    });
  });
});
