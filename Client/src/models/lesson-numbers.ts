// How many lessons one AI quiz can cover. Kept in step by hand with `MaxLessons` in
// Server/internal/csvgen/options.go (nothing generates one side from the other).
export const MAX_LESSONS = 5;

// The lessons in words, ascending: a run of three or more consecutive lessons is written as its first and
// last (3, 4, 5, 7 -> "3–5, 7"), so a long list stays short. `range` and `separator` let a file name use
// "3-5+7" instead.
export function formatLessonNumbers(numbers: readonly number[], range = '–', separator = ', '): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts: string[] = [];
  let runStart = 0;
  while (runStart < sorted.length) {
    let runEnd = runStart;
    while (runEnd + 1 < sorted.length && sorted[runEnd + 1] === sorted[runEnd] + 1) {
      runEnd++;
    }
    if (runEnd - runStart >= 2) {
      parts.push(`${sorted[runStart]}${range}${sorted[runEnd]}`);
    } else {
      parts.push(...sorted.slice(runStart, runEnd + 1).map(String));
    }
    runStart = runEnd + 1;
  }
  return parts.join(separator);
}

// What the form's lessons become when read back from storage, which may hold an older save, one written by
// hand or garbage: the positive whole numbers, each once, ascending, the first MAX_LESSONS of them.
export function lessonNumbersOf(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter(isPositiveInteger))].sort((a, b) => a - b).slice(0, MAX_LESSONS);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
