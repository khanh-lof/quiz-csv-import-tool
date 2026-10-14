import { stageDef, STAGES } from '../game/stages';

// The columns of a gesture quiz's CSV, which the AI returns without a header row (the order the server's
// prompt asks for). The downloaded file gets this header, and the quiz parses the same with or without it.
export const GESTURE_QUIZ_COLUMNS = [
  'Stage',
  'Question',
  'Correct Answer',
  'Wrong Answer 1',
  'Wrong Answer 2',
  'Wrong Answer 3',
  'Explanation',
];

// One playable question, already checked against its stage's rules. For stage 1 `correct` is exactly
// 'Đúng' or 'Sai' and `wrong` is empty. For stage 6 `chunks` are the sentence's pieces in the right
// order, `correct` is the same pieces joined by ' / ' and `wrong` is empty.
export interface GestureQuestion {
  stage: number;
  question: string;
  correct: string;
  wrong: string[];
  chunks?: string[];
  explanation: string;
}

// `stages` holds only the stages that have questions, in stage order, each list in CSV order. `key`
// identifies the quiz's content (not its title) so a player's progress can be stored per quiz.
// `skipped` counts the rows that broke a rule and were left out.
export interface GestureQuiz {
  title: string;
  key: string;
  stages: Map<number, GestureQuestion[]>;
  skipped: number;
}

const TRUE_ANSWER = 'Đúng';
const FALSE_ANSWER = 'Sai';
const WORD_ORDER_STAGE = 6;
const MIN_CHUNKS = 2;
const MAX_CHUNKS = 8;

// What a true/false answer may be written as, after `foldAnswer`: the AI does not always keep to
// 'Đúng'/'Sai', so the English and Chinese words (and the first letters) are taken too.
const TRUE_WORDS = new Set(['dung', 'd', 'true', 't', 'yes', 'dui', '对', '對', '正确', '正確', '✓', '✔']);
const FALSE_WORDS = new Set(['sai', 's', 'false', 'f', 'no', 'cuo', '错', '錯', '错误', '錯誤', '✗', '✘']);

// Lower case with accents dropped and trailing punctuation cut, so 'Đúng.', 'DUNG' and 'đúng' all match.
function foldAnswer(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[\s.!。！]+$/u, '')
    .trim();
}

// Turns one CSV row into a question, or null when it breaks its stage's rules.
function parseRow(row: string[]): GestureQuestion | null {
  const cell = (index: number): string => (row[index] ?? '').trim();

  const stageText = /\d+/.exec(cell(0));
  const stage = stageText ? Number(stageText[0]) : NaN;
  if (!STAGES.some(def => def.stage === stage)) {
    return null;
  }

  const question = cell(1);
  const correct = cell(2);
  const explanation = cell(6);
  if (!question || !correct) {
    return null;
  }

  if (stage === 1) {
    const folded = foldAnswer(correct);
    const answer = TRUE_WORDS.has(folded) ? TRUE_ANSWER : FALSE_WORDS.has(folded) ? FALSE_ANSWER : null;
    return answer ? { stage, question, correct: answer, wrong: [], explanation } : null;
  }

  if (stage === WORD_ORDER_STAGE) {
    const chunks = correct.split('/').map(chunk => chunk.trim()).filter(chunk => chunk !== '');
    if (chunks.length < MIN_CHUNKS || chunks.length > MAX_CHUNKS) {
      return null;
    }
    return { stage, question, correct: chunks.join(' / '), wrong: [], chunks, explanation };
  }

  const wrongNeeded = stageDef(stage).optionCount - 1;
  const wrong = [...new Set([cell(3), cell(4), cell(5)].filter(answer => answer !== '' && answer !== correct))];
  if (wrong.length < wrongNeeded) {
    return null;
  }
  return { stage, question, correct, wrong: wrong.slice(0, wrongNeeded), explanation };
}

// FNV-1a over the UTF-16 code units: short, dependency-free and stable across runs, which is all a
// storage key needs.
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Builds a quiz from CSV rows (`CsvImportService.parseCsvRows`). A header row is skipped when present
// and not required, empty rows are ignored, and rows that break their stage's rules are dropped and
// counted in `skipped`.
export function parseGestureQuiz(rows: string[][], title: string): GestureQuiz {
  const byStage = new Map<number, GestureQuestion[]>();
  let skipped = 0;

  for (const row of rows) {
    if (row.every(cell => cell.trim() === '')) {
      continue;
    }
    if ((row[0] ?? '').trim().toLowerCase() === 'stage') {
      continue;
    }
    const parsed = parseRow(row);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    const list = byStage.get(parsed.stage) ?? [];
    list.push(parsed);
    byStage.set(parsed.stage, list);
  }

  // Re-insert in stage order so iterating the map visits the stages easiest first, however the rows were
  // ordered in the CSV.
  const stages = new Map<number, GestureQuestion[]>();
  for (const { stage } of STAGES) {
    const questions = byStage.get(stage);
    if (questions) {
      stages.set(stage, questions);
    }
  }

  // The key covers what is played, not the title or the explanations: the quiz opened from its AI job
  // and from the CSV downloaded from it (which has a header row) must share one key.
  const played = [...stages.values()].flat().map(q => ({
    stage: q.stage,
    question: q.question,
    correct: q.correct,
    wrong: q.wrong,
    chunks: q.chunks,
  }));

  return { title, key: `gq-${fnv1a(JSON.stringify(played))}`, stages, skipped };
}

export function questionCount(quiz: GestureQuiz): number {
  let count = 0;
  for (const questions of quiz.stages.values()) {
    count += questions.length;
  }
  return count;
}

// A character that is written with spaces between words, as opposed to hanzi and punctuation.
const SPACED_CHAR = /[\p{Script=Latin}\p{N}]/u;

// The display form of a stage-6 answer: the chunks run together, as Chinese is written, except that two
// neighbouring Latin words keep a space so a sentence such as 'I / am / Lan' does not become 'IamLan'.
export function sentenceOf(chunks: string[]): string {
  let sentence = '';
  for (const chunk of chunks) {
    if (sentence !== '' && SPACED_CHAR.test(sentence.slice(-1)) && SPACED_CHAR.test(chunk.charAt(0))) {
      sentence += ' ';
    }
    sentence += chunk;
  }
  return sentence;
}
