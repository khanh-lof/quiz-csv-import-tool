import { DEMO_QUIZ_CSV, DEMO_QUIZ_TITLE } from '../game/demo-quiz';
import { passMark, STAGES, stageDef } from '../game/stages';
import { CsvImportService } from '../services/csv-import.service';
import { GestureQuiz, parseGestureQuiz, questionCount, sentenceOf } from './gesture-quiz';

function parse(csv: string, title = 'Quiz'): GestureQuiz {
  return parseGestureQuiz(new CsvImportService().parseCsvRows(csv), title);
}

describe('parseGestureQuiz', () => {
  it('groups the questions by stage and keeps their CSV order', () => {
    const quiz = parse([
      '3,Q3a,A,B,C,,e',
      '1,Q1a,Đúng,,,,e',
      '3,Q3b,A,B,C,,e',
      '1,Q1b,Sai,,,,e',
    ].join('\n'));

    expect([...quiz.stages.keys()]).toEqual([1, 3]);
    expect(quiz.stages.get(1)!.map(q => q.question)).toEqual(['Q1a', 'Q1b']);
    expect(quiz.stages.get(3)!.map(q => q.question)).toEqual(['Q3a', 'Q3b']);
    expect(quiz.stages.has(2)).toBeFalse();
    expect(questionCount(quiz)).toBe(4);
    expect(quiz.skipped).toBe(0);
  });

  it('keeps the title and the explanation', () => {
    const quiz = parse('2,Q,A,B,,,Vì sao', 'Bài 1');

    expect(quiz.title).toBe('Bài 1');
    expect(quiz.stages.get(2)![0]).toEqual({
      stage: 2, question: 'Q', correct: 'A', wrong: ['B'], explanation: 'Vì sao',
    });
  });

  it('reads the stage as the first integer in the first cell', () => {
    const quiz = parse(['Stage 2,Q,A,B,,,', ' 4 ,Q,A,B,C,,'].join('\n'));

    expect([...quiz.stages.keys()]).toEqual([2, 4]);
  });

  it('skips rows whose stage is missing or out of range', () => {
    const quiz = parse([
      '0,Q,A,B,,,',
      '7,Q,A,B,,,',
      'x,Q,A,B,,,',
      ',Q,A,B,,,',
      '2,Q,A,B,,,',
    ].join('\n'));

    expect(questionCount(quiz)).toBe(1);
    expect(quiz.skipped).toBe(4);
  });

  it('skips rows with an empty question', () => {
    const quiz = parse(['2,,A,B,,,', '2,Q,A,B,,,'].join('\n'));

    expect(questionCount(quiz)).toBe(1);
    expect(quiz.skipped).toBe(1);
  });

  describe('stage 1', () => {
    const answerOf = (cell: string): string | undefined =>
      parse(`1,Q,${cell},,,,`).stages.get(1)?.[0].correct;

    it('turns every spelling of true into Đúng', () => {
      for (const cell of ['Đúng', 'đúng', 'ĐÚNG', 'Dung', 'dung', 'Đ', 'True', 'TRUE', 'true', '对', '對', 'Đúng.']) {
        expect(answerOf(cell)).withContext(cell).toBe('Đúng');
      }
    });

    it('turns every spelling of false into Sai', () => {
      for (const cell of ['Sai', 'sai', 'SAI', 'False', 'false', '错', '錯', 'Sai.']) {
        expect(answerOf(cell)).withContext(cell).toBe('Sai');
      }
    });

    it('skips any other answer', () => {
      const quiz = parse(['1,Q,Có,,,,', '1,Q,Có thể,,,,', '1,Q,,,,,'].join('\n'));

      expect(questionCount(quiz)).toBe(0);
      expect(quiz.skipped).toBe(3);
    });

    it('drops wrong answers', () => {
      const question = parse('1,Q,Sai,x,y,z,').stages.get(1)![0];

      expect(question.wrong).toEqual([]);
    });
  });

  describe('stages 2 to 5', () => {
    it('keeps exactly as many wrong answers as the stage needs', () => {
      const quiz = parse([
        '2,Q,A,B,C,D,',
        '3,Q,A,B,C,D,',
        '4,Q,A,B,C,D,',
        '5,Q,A,B,C,D,',
      ].join('\n'));

      expect(quiz.stages.get(2)![0].wrong).toEqual(['B']);
      expect(quiz.stages.get(3)![0].wrong).toEqual(['B', 'C']);
      expect(quiz.stages.get(4)![0].wrong).toEqual(['B', 'C']);
      expect(quiz.stages.get(5)![0].wrong).toEqual(['B', 'C', 'D']);
    });

    it('skips a row with too few wrong answers', () => {
      const quiz = parse(['2,Q,A,,,,', '3,Q,A,B,,,', '4,Q,A,B,,,', '5,Q,A,B,C,,'].join('\n'));

      expect(questionCount(quiz)).toBe(0);
      expect(quiz.skipped).toBe(4);
    });

    it('closes the gaps between wrong answers', () => {
      const question = parse('3,Q,A,,B,C,').stages.get(3)![0];

      expect(question.wrong).toEqual(['B', 'C']);
    });

    it('drops wrong answers equal to the correct one and duplicates', () => {
      expect(parse('2,Q,A,A,B,B,').stages.get(2)![0].wrong).toEqual(['B']);
      expect(parse('3,Q,A,A,B,C,').stages.get(3)![0].wrong).toEqual(['B', 'C']);
      // A copy of the correct answer or of another wrong one does not count towards the number needed.
      expect(parse('3,Q,A,A,B,B,').skipped).toBe(1);
      expect(parse('5,Q,A,B,B,C,').skipped).toBe(1);
    });

    it('skips a row with no correct answer', () => {
      const quiz = parse('2,Q,,B,,,');

      expect(questionCount(quiz)).toBe(0);
      expect(quiz.skipped).toBe(1);
    });
  });

  describe('stage 6', () => {
    it('splits the answer into trimmed chunks', () => {
      const question = parse('6,Tôi là người Việt Nam.,我 / 是 /越南人 ,,,,').stages.get(6)![0];

      expect(question.chunks).toEqual(['我', '是', '越南人']);
      expect(question.correct).toBe('我 / 是 / 越南人');
      expect(question.wrong).toEqual([]);
    });

    it('ignores empty chunks', () => {
      const question = parse('6,Q,我 / / 喝 / 茶 /,,,,').stages.get(6)![0];

      expect(question.chunks).toEqual(['我', '喝', '茶']);
    });

    it('needs between 2 and 8 chunks', () => {
      const quiz = parse([
        '6,Q,我,,,,',
        '6,Q,a / b,,,,',
        '6,Q,a / b / c / d / e / f / g / h,,,,',
        '6,Q,a / b / c / d / e / f / g / h / i,,,,',
      ].join('\n'));

      expect(quiz.stages.get(6)!.map(q => q.chunks!.length)).toEqual([2, 8]);
      expect(quiz.skipped).toBe(2);
    });
  });

  it('skips a header row, in any case, and does not count it', () => {
    const quiz = parse(['Stage,Question,Correct Answer,Wrong Answer 1', '1,Q,Đúng,,,,'].join('\n'));
    const shouting = parse(['STAGE,Question', '1,Q,Đúng,,,,'].join('\n'));

    expect(questionCount(quiz)).toBe(1);
    expect(quiz.skipped).toBe(0);
    expect(questionCount(shouting)).toBe(1);
    expect(shouting.skipped).toBe(0);
  });

  it('ignores empty rows', () => {
    const quiz = parse(['', '1,Q,Đúng,,,,', ',,,,,,', '   ', '2,Q,A,B,,,'].join('\n'));

    expect(questionCount(quiz)).toBe(2);
    expect(quiz.skipped).toBe(0);
  });

  it('counts the rows it drops', () => {
    const quiz = parse(['1,Q,Đúng,,,,', '1,Q,Có,,,,', '2,Q,A,,,,', '9,Q,A,B,,,'].join('\n'));

    expect(questionCount(quiz)).toBe(1);
    expect(quiz.skipped).toBe(3);
  });

  describe('key', () => {
    const rows = ['1,Q1,Đúng,,,,why', '2,Q2,A,B,,,', '6,Q6,我 / 喝 / 茶,,,,'];

    it('is the same with and without the header row', () => {
      const header = 'Stage,Question,Correct Answer,Wrong Answer 1,Wrong Answer 2,Wrong Answer 3,Explanation';

      expect(parse([header, ...rows].join('\n')).key).toBe(parse(rows.join('\n')).key);
    });

    it('does not depend on the title', () => {
      expect(parse(rows.join('\n'), 'Bài 1').key).toBe(parse(rows.join('\n'), 'Bài 2').key);
    });

    it('does not depend on the explanations', () => {
      const other = ['1,Q1,Đúng,,,,khác', '2,Q2,A,B,,,thêm', '6,Q6,我 / 喝 / 茶,,,,'];

      expect(parse(other.join('\n')).key).toBe(parse(rows.join('\n')).key);
    });

    it('is the same for spellings that parse to the same quiz', () => {
      expect(parse('1,Q1,đúng,,,,').key).toBe(parse('1,Q1,True,,,,').key);
    });

    it('differs for different content', () => {
      const keys = new Set([
        parse(rows.join('\n')).key,
        parse(['1,Q1,Sai,,,,why', '2,Q2,A,B,,,', '6,Q6,我 / 喝 / 茶,,,,'].join('\n')).key,
        parse(['1,Q1,Đúng,,,,why', '2,Q2,A,C,,,', '6,Q6,我 / 喝 / 茶,,,,'].join('\n')).key,
        parse(['1,Q1,Đúng,,,,why', '2,Q2,A,B,,,', '6,Q6,我 / 茶 / 喝,,,,'].join('\n')).key,
        parse(['1,Q1,Đúng,,,,why', '2,Q2,A,B,,,'].join('\n')).key,
      ]);

      expect(keys.size).toBe(5);
    });

    it('looks like gq- and eight hex digits', () => {
      expect(parse(rows.join('\n')).key).toMatch(/^gq-[0-9a-f]{8}$/);
    });
  });
});

describe('sentenceOf', () => {
  it('runs Chinese chunks together', () => {
    expect(sentenceOf(['我', '是', '越南人'])).toBe('我是越南人');
  });

  it('keeps a space between two Latin words', () => {
    expect(sentenceOf(['I', 'am', 'Lan'])).toBe('I am Lan');
  });

  it('puts no space between a Latin word and hanzi or punctuation', () => {
    expect(sentenceOf(['我', '叫', 'Lan'])).toBe('我叫Lan');
    expect(sentenceOf(['Lan', '是', '学生', '吗', '?'])).toBe('Lan是学生吗?');
  });

  it('copes with no chunks and one chunk', () => {
    expect(sentenceOf([])).toBe('');
    expect(sentenceOf(['你好'])).toBe('你好');
  });
});

describe('stages', () => {
  it('lists stages 1 to 6 in order and finds each by number', () => {
    expect(STAGES.map(def => def.stage)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stageDef(4).game).toBe('fruit-slice');
    expect(() => stageDef(7)).toThrow();
  });

  it('asks for 70 percent, rounded up', () => {
    expect(passMark(0)).toBe(0);
    expect(passMark(5)).toBe(4);
    expect(passMark(10)).toBe(7);
    expect(passMark(1)).toBe(1);
  });
});

describe('demo quiz', () => {
  const quiz = parse(DEMO_QUIZ_CSV, DEMO_QUIZ_TITLE);

  it('parses without skipping a row', () => {
    expect(quiz.skipped).toBe(0);
    expect(quiz.title).toBe('Quiz mẫu HSK 1');
  });

  it('has 4 or 5 questions in each of the six stages', () => {
    expect([...quiz.stages.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
    for (const [stage, questions] of quiz.stages) {
      expect(questions.length).withContext(`stage ${stage}`).toBeGreaterThanOrEqual(4);
      expect(questions.length).withContext(`stage ${stage}`).toBeLessThanOrEqual(5);
    }
  });

  it('has true and false statements in stage 1 and an explanation on every question', () => {
    const answers = quiz.stages.get(1)!.map(q => q.correct);

    expect(answers).toContain('Đúng');
    expect(answers).toContain('Sai');
    for (const questions of quiz.stages.values()) {
      for (const question of questions) {
        expect(question.explanation).withContext(question.question).not.toBe('');
      }
    }
  });

  it('has a blank to fill in every stage 4 question', () => {
    for (const question of quiz.stages.get(4)!) {
      expect(question.question).toContain('____');
    }
  });
});
