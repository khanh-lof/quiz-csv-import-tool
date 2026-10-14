// How a teacher can set an assignment's closing time: not at all, soon after starting, at the end of the
// lesson day, or at a time of their own.
export type DeadlinePreset = 'none' | '45m' | 'today' | 'custom';

const MINUTE_MS = 60_000;
const SHORT_LESSON_MINUTES = 45;
// Closing "today" a few minutes from now would shut the link before the students have opened it, so
// with less than this left in the day the preset means the end of tomorrow.
const MIN_TODAY_MINUTES = 10;

// The closing time a preset stands for, in the browser's time zone. `custom` is whatever the teacher
// picked (or null while nothing valid is picked yet).
export function deadlineFromPreset(preset: DeadlinePreset, now: Date, custom: Date | null): Date | null {
  switch (preset) {
    case 'none':
      return null;
    case '45m':
      return new Date(now.getTime() + SHORT_LESSON_MINUTES * MINUTE_MS);
    case 'today': {
      const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0, 0);
      if (endOfToday.getTime() - now.getTime() >= MIN_TODAY_MINUTES * MINUTE_MS) {
        return endOfToday;
      }
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 59, 0, 0);
    }
    case 'custom':
      return custom;
  }
}
