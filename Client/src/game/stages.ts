import { VisionKind } from './stage-game';

export type GameKind =
  | 'true-false'
  | 'head-tilt'
  | 'frog-bite'
  | 'fruit-slice'
  | 'finger-count'
  | 'word-order';

// One stage of the gesture quiz. `optionCount` is how many answers the player picks from (0 for the
// sentence-ordering stage, which has chunks instead) and `seconds` the time allowed per question.
export interface StageDef {
  stage: number;
  game: GameKind;
  name: string;
  icon: string;
  hint: string;
  vision: VisionKind;
  optionCount: number;
  seconds: number;
}

// Easiest to hardest: the player has to pass a stage to unlock the next one.
export const STAGES: StageDef[] = [
  {
    stage: 1,
    game: 'true-false',
    name: 'Đúng hay sai',
    icon: '👍',
    hint: 'Giơ ngón cái lên để chọn Đúng, chúc ngón cái xuống để chọn Sai và giữ một chút.',
    vision: 'hand',
    optionCount: 2,
    seconds: 12,
  },
  {
    stage: 2,
    game: 'head-tilt',
    name: 'Nghiêng đầu',
    icon: '🙆',
    hint: 'Nghiêng hoặc dịch đầu về phía đáp án bạn chọn và giữ yên một chút.',
    vision: 'face',
    optionCount: 2,
    seconds: 12,
  },
  {
    stage: 3,
    game: 'frog-bite',
    name: 'Ếch đớp chữ',
    icon: '🐸',
    hint: 'Dịch đầu sang làn có đáp án đúng rồi há miệng để ếch đớp.',
    vision: 'face',
    optionCount: 3,
    seconds: 15,
  },
  {
    stage: 4,
    game: 'fruit-slice',
    name: 'Chém hoa quả',
    icon: '🍉',
    hint: 'Vung ngón trỏ chém quả có cùng màu với đáp án đúng.',
    vision: 'hand',
    optionCount: 3,
    seconds: 15,
  },
  {
    stage: 5,
    game: 'finger-count',
    name: 'Giơ ngón tay',
    icon: '✋',
    hint: 'Giơ 1–4 ngón tay (không tính ngón cái) theo số của đáp án và giữ yên một chút.',
    vision: 'hand',
    optionCount: 4,
    seconds: 20,
  },
  {
    stage: 6,
    game: 'word-order',
    name: 'Xếp câu',
    icon: '🧩',
    hint: 'Chỉ ngón trỏ vào các mảnh theo đúng thứ tự, giữ yên hoặc chụm ngón cái và ngón trỏ để chọn.',
    vision: 'hand',
    optionCount: 0,
    seconds: 45,
  },
];

// A stage is passed with at least this share of its questions answered correctly.
export const PASS_RATIO = 0.7;

// How many of `total` questions must be right to pass: 4 of 5, 7 of 10; 0 when there are none.
export function passMark(total: number): number {
  return total <= 0 ? 0 : Math.ceil(PASS_RATIO * total);
}

export function stageDef(stage: number): StageDef {
  const def = STAGES.find(candidate => candidate.stage === stage);
  if (!def) {
    throw new Error(`Unknown stage ${stage}`);
  }
  return def;
}

// The number a person reads for a stage: its 1-based position among the stage numbers the quiz (or the
// assignment) has, easiest first, so a quiz of stages 4 and 6 shows them as "Màn 1" and "Màn 2". The
// stage number itself (1-6) is what identifies the game everywhere it is stored or sent (the CSV, the
// progress, the results), so it never changes; only what is shown is renumbered. A stage the quiz does
// not have gets the position it would take, and repeated numbers count once.
export function stagePosition(stages: Iterable<number>, stage: number): number {
  let position = 1;
  for (const other of new Set(stages)) {
    if (other < stage) {
      position += 1;
    }
  }
  return position;
}
