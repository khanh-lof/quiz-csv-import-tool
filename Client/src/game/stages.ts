import type { MessageKey } from '../i18n/messages';
import { VisionKind } from './stage-game';

export type GameKind =
  | 'true-false'
  | 'head-tilt'
  | 'frog-bite'
  | 'fruit-slice'
  | 'finger-count'
  | 'word-order';

// One stage of the gesture quiz. `optionCount` is how many answers the player picks from (0 for the
// sentence-ordering stage, which has chunks instead) and `seconds` the time allowed per question. The seconds are
// only the defaults for practice, a quiz played from a file or from one of the user's jobs: an assignment's limits
// are the server's (`timeLimits` of its answers), because a page could change this table.
export interface StageDef {
  stage: number;
  game: GameKind;
  nameKey: MessageKey;
  icon: string;
  hint: MessageKey;
  vision: VisionKind;
  optionCount: number;
  seconds: number;
}

// The two stages whose shape is fixed: stage 1 answers are always these two words, in this order (index 0 is
// the thumbs-up answer), and stage 6 has chunks to put in order instead of options.
export const TRUE_FALSE_STAGE = 1;
export const WORD_ORDER_STAGE = 6;
export const TRUE_ANSWER = 'Đúng';
export const FALSE_ANSWER = 'Sai';

// Easiest to hardest: the player has to pass a stage to unlock the next one.
export const STAGES: StageDef[] = [
  {
    stage: 1,
    game: 'true-false',
    nameKey: 'play.stage.name.trueFalse',
    icon: '👍',
    hint: 'play.stage.hint.trueFalse',
    vision: 'hand',
    optionCount: 2,
    seconds: 12,
  },
  {
    stage: 2,
    game: 'head-tilt',
    nameKey: 'play.stage.name.headTilt',
    icon: '🙆',
    hint: 'play.stage.hint.headTilt',
    vision: 'face',
    optionCount: 2,
    seconds: 12,
  },
  {
    stage: 3,
    game: 'frog-bite',
    nameKey: 'play.stage.name.frogBite',
    icon: '🐸',
    hint: 'play.stage.hint.frogBite',
    vision: 'face',
    optionCount: 3,
    seconds: 15,
  },
  {
    stage: 4,
    game: 'fruit-slice',
    nameKey: 'play.stage.name.fruitSlice',
    icon: '🍉',
    hint: 'play.stage.hint.fruitSlice',
    vision: 'hand',
    optionCount: 3,
    seconds: 15,
  },
  {
    stage: 5,
    game: 'finger-count',
    nameKey: 'play.stage.name.fingerCount',
    icon: '✋',
    hint: 'play.stage.hint.fingerCount',
    vision: 'hand',
    optionCount: 4,
    seconds: 20,
  },
  {
    stage: 6,
    game: 'word-order',
    nameKey: 'play.stage.name.wordOrder',
    icon: '🧩',
    hint: 'play.stage.hint.wordOrder',
    vision: 'hand',
    optionCount: 0,
    seconds: 45,
  },
];

// A stage is passed with at least this percentage of its questions answered correctly. A teacher can set
// another percentage per stage for an assignment (MIN to MAX, whole numbers); 70 is the default everywhere.
export const DEFAULT_PASS_PERCENT = 70;
export const MIN_PASS_PERCENT = 10;
export const MAX_PASS_PERCENT = 100;

// How many of `total` questions must be right to pass at `percent`: 4 of 5 and 7 of 10 at 70%; 0 when there
// are none. Whole-number arithmetic (a ceiling of percent * total / 100), the same as the server's, so the
// two never disagree through floating point.
export function passMark(total: number, percent: number = DEFAULT_PASS_PERCENT): number {
  return total <= 0 ? 0 : Math.floor((percent * total + 99) / 100);
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
