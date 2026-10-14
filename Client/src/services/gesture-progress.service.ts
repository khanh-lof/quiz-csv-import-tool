import { Injectable, signal } from '@angular/core';
import { DEFAULT_PASS_PERCENT, passMark, STAGES } from '../game/stages';
import { GestureQuiz } from '../models/gesture-quiz';

const STORAGE_KEY = 'gesture-quiz-progress';

// How many points each right answer is worth: the page scores by it, and the best score of a stage is
// derived from its best correct count, so the progress does not have to store points.
export const POINTS_PER_CORRECT = 10;

export interface StageBest {
  correct: number;
  total: number;
}

interface QuizProgress {
  passed: number[];
  best: Record<number, StageBest>;
}

type ProgressStore = Record<string, QuizProgress>;

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// Keeps only what looks like progress: anything else (a hand-edited or older value) is dropped instead
// of breaking the page.
function sanitizeQuiz(value: unknown): QuizProgress | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { passed, best } = value as { passed?: unknown; best?: unknown };
  const stages = new Set(STAGES.map(def => def.stage));
  const progress: QuizProgress = {
    passed: Array.isArray(passed)
      ? [...new Set(passed.filter((stage): stage is number => stages.has(stage)))]
      : [],
    best: {},
  };
  if (typeof best === 'object' && best !== null) {
    for (const [stage, entry] of Object.entries(best)) {
      const { correct, total } = (entry ?? {}) as { correct?: unknown; total?: unknown };
      if (stages.has(Number(stage)) && isWholeNumber(correct) && isWholeNumber(total) && correct <= total) {
        progress.best[Number(stage)] = { correct, total };
      }
    }
  }
  return progress;
}

function loadStore(): ProgressStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const store: ProgressStore = {};
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        const progress = sanitizeQuiz(value);
        if (progress) {
          store[key] = progress;
        }
      }
    }
    return store;
  } catch {
    // Unreadable or blocked storage: play on without saved progress.
    return {};
  }
}

function saveStore(store: ProgressStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage full or blocked: the progress then lasts only until the page is closed.
  }
}

// What a player has passed in each gesture quiz and the best result of every stage, kept in
// localStorage per quiz (`GestureQuiz.key`, a hash of the questions). The stage map reads it through
// the signal, so a change shows without any reload.
@Injectable({ providedIn: 'root' })
export class GestureProgressService {
  private readonly store = signal<ProgressStore>(loadStore());

  isPassed(key: string, stage: number): boolean {
    return this.store()[key]?.passed.includes(stage) ?? false;
  }

  // Stage 1 is always open; any other stage opens once every earlier stage is passed or has no
  // questions in this quiz (a stage nobody can play must not block the ones after it).
  isUnlocked(quiz: GestureQuiz, stage: number): boolean {
    return STAGES.filter(def => def.stage < stage).every(
      def => !quiz.stages.has(def.stage) || this.isPassed(quiz.key, def.stage),
    );
  }

  best(key: string, stage: number): StageBest | null {
    return this.store()[key]?.best[stage] ?? null;
  }

  // Stores a finished run and says whether it passed the stage at `percent` right (an assignment's own
  // pass percentage, else the default). The best result only improves, and a stage that was passed once
  // stays passed however a later run goes.
  record(key: string, stage: number, correct: number, total: number, percent: number = DEFAULT_PASS_PERCENT): boolean {
    const passed = correct >= passMark(total, percent);
    // Read again before writing, so a second tab's progress is not overwritten by this tab's older copy.
    const store = loadStore();
    const progress = store[key] ?? { passed: [], best: {} };
    if (passed && !progress.passed.includes(stage)) {
      progress.passed.push(stage);
    }
    const previous = progress.best[stage];
    if (!previous || correct * previous.total > previous.correct * total) {
      progress.best[stage] = { correct, total };
    }
    store[key] = progress;
    saveStore(store);
    this.store.set(store);
    return passed;
  }

  reset(key: string): void {
    const store = loadStore();
    delete store[key];
    saveStore(store);
    this.store.set(store);
  }
}
