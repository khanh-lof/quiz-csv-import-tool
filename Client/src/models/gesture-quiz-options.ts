import { STAGES } from '../game/stages';

// How many questions each stage of an AI-written Game gets. The same three numbers as the
// server's csvgen constants, kept in step by hand (nothing generates one side from the other). Four is
// the least because the pass mark is 70%: with fewer questions a stage would be all or nothing.
export const QUESTIONS_PER_STAGE_MIN = 4;
export const QUESTIONS_PER_STAGE_MAX = 10;
export const QUESTIONS_PER_STAGE_DEFAULT = 5;

// Every game of the quiz, by the stage number that identifies it everywhere (the CSV's Stage column,
// progress, results). A request that does not narrow the choice asks for all of them.
export const ALL_GESTURE_STAGES: readonly number[] = STAGES.map(def => def.stage);

// What the form's settings become when read back from storage, which may hold an older save, one
// written by hand or garbage: the valid stage numbers, each once, easiest first. Nothing usable (or
// nothing left over, since a quiz with no game cannot be asked for) gives all of them.
export function gestureStagesOf(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [...ALL_GESTURE_STAGES];
  }
  const kept = ALL_GESTURE_STAGES.filter(stage => value.includes(stage));
  return kept.length > 0 ? kept : [...ALL_GESTURE_STAGES];
}

// An integer within the allowed range, else the default.
export function questionsPerStageOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= QUESTIONS_PER_STAGE_MIN && value <= QUESTIONS_PER_STAGE_MAX
    ? value
    : QUESTIONS_PER_STAGE_DEFAULT;
}
