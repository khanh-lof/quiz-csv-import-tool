import { GestureQuestion } from '../../models/gesture-quiz';
import {
  correctAnswerText,
  isCorrectChoice,
  judge,
  prepareQuestion,
  shuffleChunks,
  timeLimitFor,
  timeoutReveal,
  titleFromFileName,
} from './gesture-engine';

function question(stage: number, overrides: Partial<GestureQuestion> = {}): GestureQuestion {
  return { stage, question: 'Q', correct: 'Đúng', wrong: [], explanation: 'Vì sao', ...overrides };
}

describe('prepareQuestion', () => {
  it('gives stage 1 the options Đúng and Sai with the answer at its own index', () => {
    const yes = prepareQuestion(question(1, { correct: 'Đúng' }));
    const no = prepareQuestion(question(1, { correct: 'Sai' }));

    expect(yes.view.options).toEqual(['Đúng', 'Sai']);
    expect(yes.correctIndex).toBe(0);
    expect(no.view.options).toEqual(['Đúng', 'Sai']);
    expect(no.correctIndex).toBe(1);
  });

  it('mixes the right answer in with the wrong ones and remembers where it went', () => {
    for (let run = 0; run < 30; run += 1) {
      const play = prepareQuestion(question(4, { correct: 'A', wrong: ['B', 'C'] }));

      expect([...play.view.options].sort()).toEqual(['A', 'B', 'C']);
      expect(play.view.options[play.correctIndex!]).toBe('A');
      expect(play.correctOrder).toBeNull();
    }
  });

  it('actually shuffles the options', () => {
    const positions = new Set<number>();
    for (let run = 0; run < 100; run += 1) {
      positions.add(prepareQuestion(question(5, { correct: 'A', wrong: ['B', 'C', 'D'] })).correctIndex!);
    }

    expect(positions.size).toBeGreaterThan(1);
  });

  it('gives the sentence stage no options and shuffled pieces', () => {
    const play = prepareQuestion(question(6, { correct: '我 / 喝 / 茶', chunks: ['我', '喝', '茶'] }));

    expect(play.view.options).toEqual([]);
    expect([...play.view.chunks!].sort()).toEqual(['喝', '我', '茶']);
    expect(play.correctOrder).toEqual(['我', '喝', '茶']);
    expect(play.correctIndex).toBeNull();
  });

  it('does not change the question it is built from', () => {
    const source = question(6, { chunks: ['a', 'b', 'c'] });

    prepareQuestion(source);

    expect(source.chunks).toEqual(['a', 'b', 'c']);
  });
});

describe('shuffleChunks', () => {
  it('never leaves the pieces in the right order', () => {
    const chunks = ['我', '是', '学生'];
    for (let run = 0; run < 200; run += 1) {
      expect(shuffleChunks(chunks)).not.toEqual(chunks);
    }
  });

  it('works for two pieces', () => {
    for (let run = 0; run < 20; run += 1) {
      expect(shuffleChunks(['a', 'b'])).toEqual(['b', 'a']);
    }
  });

  it('keeps the pieces when a sentence repeats a word', () => {
    for (let run = 0; run < 100; run += 1) {
      const mixed = shuffleChunks(['a', 'b', 'a']);

      expect([...mixed].sort()).toEqual(['a', 'a', 'b']);
      expect(mixed).not.toEqual(['a', 'b', 'a']);
    }
  });

  it('cannot tell identical pieces apart, so it leaves them', () => {
    expect(shuffleChunks(['a', 'a'])).toEqual(['a', 'a']);
  });
});

describe('judging', () => {
  it('compares an option stage by index', () => {
    const play = prepareQuestion(question(2, { correct: 'A', wrong: ['B'] }));
    const right = play.correctIndex!;

    expect(isCorrectChoice(play, right)).toBeTrue();
    expect(isCorrectChoice(play, 1 - right)).toBeFalse();
    expect(judge(play, right)).toEqual({ chosen: right, correct: true, correctIndex: right });
    expect(judge(play, 1 - right)).toEqual({ chosen: 1 - right, correct: false, correctIndex: right });
  });

  it('treats index 0 as a real choice', () => {
    const play = prepareQuestion(question(1, { correct: 'Đúng' }));

    expect(judge(play, 0).correct).toBeTrue();
    expect(judge(play, 1).correct).toBeFalse();
  });

  it('compares the sentence stage piece by piece as text', () => {
    const play = prepareQuestion(question(6, { chunks: ['我', '喝', '茶'] }));

    expect(judge(play, ['我', '喝', '茶'])).toEqual({
      chosen: ['我', '喝', '茶'],
      correct: true,
      correctOrder: ['我', '喝', '茶'],
    });
    expect(judge(play, ['我', '茶', '喝']).correct).toBeFalse();
    expect(judge(play, ['我', '喝']).correct).toBeFalse();
  });

  it('accepts either copy of a repeated word', () => {
    const play = prepareQuestion(question(6, { chunks: ['a', 'b', 'a'] }));

    expect(judge(play, ['a', 'b', 'a']).correct).toBeTrue();
  });

  it('counts a choice of the wrong kind as wrong', () => {
    const options = prepareQuestion(question(2, { correct: 'A', wrong: ['B'] }));
    const sentence = prepareQuestion(question(6, { chunks: ['a', 'b'] }));

    expect(isCorrectChoice(options, ['A'])).toBeFalse();
    expect(isCorrectChoice(sentence, 0)).toBeFalse();
  });

  it('reveals the right answer when time runs out', () => {
    const options = prepareQuestion(question(3, { correct: 'A', wrong: ['B', 'C'] }));
    const sentence = prepareQuestion(question(6, { chunks: ['a', 'b'] }));

    expect(timeoutReveal(options)).toEqual({ chosen: null, correct: false, correctIndex: options.correctIndex! });
    expect(timeoutReveal(sentence)).toEqual({ chosen: null, correct: false, correctOrder: ['a', 'b'] });
  });
});

describe('correctAnswerText', () => {
  it('shows the option, or the sentence run together', () => {
    expect(correctAnswerText(prepareQuestion(question(2, { correct: '水 (shuǐ)', wrong: ['茶'] })))).toBe(
      '水 (shuǐ)',
    );
    expect(correctAnswerText(prepareQuestion(question(6, { chunks: ['我', '喝', '茶'] })))).toBe('我喝茶');
  });
});

describe('timeLimitFor', () => {
  it('uses the stage seconds, half as long again, or no limit', () => {
    expect(timeLimitFor(12, 'standard')).toBe(12);
    expect(timeLimitFor(15, 'extra')).toBe(23);
    expect(timeLimitFor(12, 'extra')).toBe(18);
    expect(timeLimitFor(45, 'unlimited')).toBeNull();
  });
});

describe('titleFromFileName', () => {
  it('drops the extension and the suffix of a downloaded file', () => {
    expect(titleFromFileName('HSK3-Bai5-Game.csv')).toBe('HSK3-Bai5');
    expect(titleFromFileName('Boya-Bai-2-Game.CSV')).toBe('Boya-Bai-2');
  });

  it('matches the suffix when the accents are separate marks', () => {
    // "cử" and "chỉ" written as a base letter followed by the horn and hook-above marks.
    expect(titleFromFileName('Bai1-Quiz-cử-chỉ.csv')).toBe('Bai1');
  });

  it('keeps any other name as it is', () => {
    expect(titleFromFileName('bai hoc.v2.csv')).toBe('bai hoc.v2');
    expect(titleFromFileName('quiz')).toBe('quiz');
  });

  it('falls back to a name when nothing is left', () => {
    expect(titleFromFileName('-Game.csv')).toBe('Game');
    expect(titleFromFileName('.csv')).toBe('Game');
  });
});
