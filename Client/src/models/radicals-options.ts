// "Ghép bộ thủ" (ExportType.Radicals): the exercise page in which the learner completes each character by picking
// its missing component. The server builds it from the lesson's words (package radicals); these are the form's
// limits and the shape of the review data the job carries. Keep in step with Server/internal/csvgen/options.go
// (MaxVocabularyWords, MaxWordRunes) and the colour presets of Server/internal/radicals.

export const MAX_VOCABULARY_WORDS = 60;
export const MAX_WORD_LENGTH = 8;

export interface RadicalsPreset {
  value: string;
  label: string;
  // The preset's main colour, shown as a swatch.
  color: string;
}

export const RADICALS_PRESETS: RadicalsPreset[] = [
  { value: 'jade', label: 'Xanh ngọc', color: '#0e7a67' },
  { value: 'blue', label: 'Xanh dương', color: '#1f5fbf' },
  { value: 'lilac', label: 'Tím hoa cà', color: '#6a3fb5' },
  { value: 'terracotta', label: 'Cam đất', color: '#c2570c' },
  { value: 'rose', label: 'Hồng đào', color: '#c2185b' },
  { value: 'red_black', label: 'Đỏ đen', color: '#b3261e' },
];

export const DEFAULT_RADICALS_PRESET = RADICALS_PRESETS[0].value;

export function radicalsPresetOf(value: unknown): string {
  return RADICALS_PRESETS.some(preset => preset.value === value) ? value as string : DEFAULT_RADICALS_PRESET;
}

// CJK ideographs only, as the server's radicals.IsHanzi accepts them.
const HANZI = /^[㐀-䶿一-鿿\u{20000}-\u{2a6df}]+$/u;

// What the tag input makes of a typed or pasted entry: its words, split on spaces, commas and 、, with anything
// that is not Chinese characters (pinyin, numbering, brackets) dropped, as `rejected`.
export function splitWords(text: string): { words: string[]; rejected: string[] } {
  const words: string[] = [];
  const rejected: string[] = [];
  for (const token of text.split(/[\s,，、;；/]+/)) {
    const word = token.replace(/[（(][^）)]*[）)]/g, '').replace(/[.。…]/g, '');
    if (word === '') {
      continue;
    }
    if (HANZI.test(word) && [...word].length <= MAX_WORD_LENGTH) {
      if (!words.includes(word)) {
        words.push(word);
      }
    } else {
      rejected.push(token);
    }
  }
  return { words, rejected };
}

// The typed words to send, keyed by lesson number: only the chosen lessons, only lessons with words, each list
// without repeats and at most MAX_VOCABULARY_WORDS long. Null when nothing was typed.
export function vocabularyFor(vocabulary: Record<number, string[]> | null, lessons: number[]): Record<number, string[]> | null {
  const out: Record<number, string[]> = {};
  for (const lesson of lessons) {
    const words = [...new Set(vocabulary?.[lesson] ?? [])].slice(0, MAX_VOCABULARY_WORDS);
    if (words.length > 0) {
      out[lesson] = words;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// What the teacher should check in a finished exercise, as the job's JSON carries it (radicals.Review).
export interface RadicalsReview {
  aiWords: string[] | null;
  uncertainWords: string[] | null;
  droppedWords: string[] | null;
  aiChars: string[] | null;
  aiComponents: string[] | null;
  pinyinWarnings: { lesson: number; word: string; char: string; syllable: string; readings: string[] }[] | null;
  skippedLessons: { lesson: number; usableWordCount: number; unusableWords: string[] }[] | null;
  missingGlyphs: string[] | null;
}

// The review of a Radicals job's result; null when the JSON cannot be read.
export function radicalsReviewOf(json: string): RadicalsReview | null {
  try {
    const review = JSON.parse(json)?.review;
    return review && typeof review === 'object' ? review as RadicalsReview : null;
  } catch {
    return null;
  }
}

// Whether a review has anything worth showing.
export function hasReviewItems(review: RadicalsReview): boolean {
  return [review.aiWords, review.uncertainWords, review.droppedWords, review.aiChars, review.aiComponents,
    review.pinyinWarnings, review.skippedLessons, review.missingGlyphs].some(list => (list?.length ?? 0) > 0);
}
