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

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

// The value of an <input type="datetime-local">: the local date and time, 'yyyy-MM-ddTHH:mm'.
export function toLocalInputValue(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

// The Date a datetime-local value stands for, or null when it is empty or not a real date and time
// (the input gives '' while it is incomplete).
export function fromLocalInputValue(text: string): Date | null {
  const match = LOCAL_INPUT.exec(text.trim());
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => (part === undefined ? 0 : Number(part)));
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  // new Date rolls 31 February over to March: such a value is not a date the teacher picked.
  const real = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    && date.getHours() === hour && date.getMinutes() === minute;
  return real ? date : null;
}
