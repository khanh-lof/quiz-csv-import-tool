import { Choice, QuestionView, Reveal } from '../../game/stage-game';
import { GestureQuestion, sentenceOf } from '../../models/gesture-quiz';
import { Utils } from '../../utils';
import { TimeMode } from './gesture-settings.service';

const TRUE_FALSE_STAGE = 1;
const WORD_ORDER_STAGE = 6;
const EXTRA_TIME_FACTOR = 1.5;
const QUIZ_FILE_SUFFIX = /-Quiz-cử-chỉ$/i;

// A question ready to play: the view a game shows, plus what the page needs to judge the answer (the
// games never see these).
export interface PlayQuestion {
  source: GestureQuestion;
  view: QuestionView;
  // Where the right option ended up after shuffling; null for the sentence stage.
  correctIndex: number | null;
  // The pieces of the sentence in the right order; null for the option stages.
  correctOrder: string[] | null;
}

export function shuffled<T>(items: readonly T[]): T[] {
  return Utils.shuffle([...items]);
}

// The pieces in a random order that is not the right one, so the player always has something to do.
// A sentence whose pieces are all the same cannot be told apart from the answer, so it stays as is.
export function shuffleChunks(chunks: readonly string[]): string[] {
  const mixed = shuffled(chunks);
  const sameAsAnswer = mixed.every((chunk, i) => chunk === chunks[i]);
  const allSame = chunks.every(chunk => chunk === chunks[0]);
  // Moving every piece one place along differs from the original unless all pieces are equal, so
  // there is no need to shuffle again and again.
  return sameAsAnswer && !allSame ? [...mixed.slice(1), mixed[0]] : mixed;
}

// Builds what the page plays for one question. Stage 1 is always 'Đúng'/'Sai' in that order (index 0 is
// the thumbs-up answer); stages 2-5 mix the right answer in with the wrong ones; stage 6 has no
// options, only the shuffled pieces of the sentence.
export function prepareQuestion(question: GestureQuestion): PlayQuestion {
  const { stage } = question;
  if (stage === WORD_ORDER_STAGE) {
    const order = question.chunks ?? [];
    return {
      source: question,
      view: { stage, question: question.question, options: [], chunks: shuffleChunks(order) },
      correctIndex: null,
      correctOrder: order,
    };
  }
  if (stage === TRUE_FALSE_STAGE) {
    return {
      source: question,
      view: { stage, question: question.question, options: ['Đúng', 'Sai'] },
      correctIndex: question.correct === 'Đúng' ? 0 : 1,
      correctOrder: null,
    };
  }
  const options = shuffled([question.correct, ...question.wrong]);
  return {
    source: question,
    view: { stage, question: question.question, options },
    correctIndex: options.indexOf(question.correct),
    correctOrder: null,
  };
}

// Whether a choice from a game is the right answer. A choice of the wrong kind (an index for the
// sentence stage, pieces for an option stage) is simply wrong. Pieces are compared as text, so a
// sentence with a repeated word accepts either copy.
export function isCorrectChoice(play: PlayQuestion, choice: Choice): boolean {
  if (play.correctOrder) {
    return (
      Array.isArray(choice) &&
      choice.length === play.correctOrder.length &&
      choice.every((chunk, i) => chunk === play.correctOrder![i])
    );
  }
  return typeof choice === 'number' && choice === play.correctIndex;
}

export function judge(play: PlayQuestion, choice: Choice): Reveal {
  return { chosen: choice, correct: isCorrectChoice(play, choice), ...answerOf(play) };
}

// The verdict when time runs out: nothing was chosen, and the right answer is shown all the same.
export function timeoutReveal(play: PlayQuestion): Reveal {
  return { chosen: null, correct: false, ...answerOf(play) };
}

function answerOf(play: PlayQuestion): Pick<Reveal, 'correctIndex' | 'correctOrder'> {
  return play.correctOrder
    ? { correctOrder: play.correctOrder }
    : { correctIndex: play.correctIndex ?? undefined };
}

// The right answer as text for the feedback bar: the option itself, or the finished sentence.
export function correctAnswerText(play: PlayQuestion): string {
  return play.correctOrder ? sentenceOf(play.correctOrder) : play.source.correct;
}

// Seconds a question lasts in this mode, or null when there is no limit.
export function timeLimitFor(stageSeconds: number, mode: TimeMode): number | null {
  switch (mode) {
    case 'unlimited':
      return null;
    case 'extra':
      return Math.round(stageSeconds * EXTRA_TIME_FACTOR);
    default:
      return stageSeconds;
  }
}

// The quiz's name from the file's: no extension, and without the suffix the app puts on the files it
// downloads ("HSK3-Bai5-Quiz-cử-chỉ.csv" is the quiz "HSK3-Bai5"). Normalized first, because a file
// system may keep the accents as separate marks.
export function titleFromFileName(fileName: string): string {
  const base = fileName.normalize('NFC').replace(/\.[^./\\]+$/, '').replace(QUIZ_FILE_SUFFIX, '').trim();
  return base || 'Quiz cử chỉ';
}
