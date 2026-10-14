import { passMark, STAGES, stageDef, stagePosition } from './stages';

describe('stagePosition', () => {
  it('is the stage number itself when the quiz has all six stages', () => {
    const all = STAGES.map(def => def.stage);
    expect(all.map(stage => stagePosition(all, stage))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('counts only the stages the quiz has', () => {
    expect(stagePosition([4, 6], 4)).toBe(1);
    expect(stagePosition([4, 6], 6)).toBe(2);
    expect(stagePosition([2, 3, 5], 5)).toBe(3);
  });

  it('is 1 for the only stage', () => {
    expect(stagePosition([5], 5)).toBe(1);
  });

  it('does not depend on the order the stages are given in', () => {
    expect(stagePosition([6, 1, 4], 4)).toBe(2);
    expect(stagePosition(new Set([6, 1, 4]), 6)).toBe(3);
  });

  it('reads the keys of a map, the way a parsed quiz holds its stages', () => {
    const stages = new Map([[3, ['x']], [6, ['y']]]);
    expect(stagePosition(stages.keys(), 6)).toBe(2);
  });

  it('counts a repeated stage number once', () => {
    expect(stagePosition([4, 4, 6], 6)).toBe(2);
  });

  it('gives a stage the quiz lacks the position it would take', () => {
    expect(stagePosition([4, 6], 5)).toBe(2);
    expect(stagePosition([4, 6], 1)).toBe(1);
  });
});

describe('stages', () => {
  it('lists the six games by their stage number', () => {
    expect(STAGES.map(def => def.stage)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stageDef(4).name).toBe('Chém hoa quả');
    expect(stageDef(6).name).toBe('Xếp câu');
    expect(() => stageDef(7)).toThrowError('Unknown stage 7');
  });

  it('passes a stage with 70% of its questions right', () => {
    expect(passMark(5)).toBe(4);
    expect(passMark(10)).toBe(7);
    expect(passMark(0)).toBe(0);
  });
});
