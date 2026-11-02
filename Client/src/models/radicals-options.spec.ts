import {
  DEFAULT_RADICALS_PRESET,
  hasReviewItems,
  MAX_VOCABULARY_WORDS,
  radicalsPresetOf,
  radicalsReviewOf,
  splitWords,
  vocabularyFor
} from './radicals-options';

describe('radicals options', () => {
  describe('splitWords', () => {
    it('splits on spaces, commas and 、 and keeps each word once', () => {
      expect(splitWords('图书馆, 借 还、借，复习').words).toEqual(['图书馆', '借', '还', '复习']);
    });

    it('drops what is not Chinese characters and says so', () => {
      const { words, rejected } = splitWords('图书馆 túshūguǎn 1. 借');
      expect(words).toEqual(['图书馆', '借']);
      expect(rejected).toEqual(['túshūguǎn', '1.']);
    });

    it('writes an optional part out of the word and refuses one that is too long', () => {
      expect(splitWords('南（方） 一二三四五六七八九').words).toEqual(['南']);
      expect(splitWords('一二三四五六七八九').rejected).toEqual(['一二三四五六七八九']);
    });
  });

  describe('vocabularyFor', () => {
    it('keeps only the chosen lessons that have words', () => {
      expect(vocabularyFor({ 1: ['好'], 2: [], 3: ['人'] }, [1, 2])).toEqual({ 1: ['好'] });
    });

    it('is null when nothing was typed', () => {
      expect(vocabularyFor(null, [1])).toBeNull();
      expect(vocabularyFor({ 1: [] }, [1])).toBeNull();
    });

    it('caps a lesson at the server limit', () => {
      const many = Array.from({ length: MAX_VOCABULARY_WORDS + 5 }, (_, i) => String.fromCodePoint(0x4e00 + i));
      expect(vocabularyFor({ 1: many }, [1])![1].length).toBe(MAX_VOCABULARY_WORDS);
    });
  });

  it('falls back to the default preset for an unknown one', () => {
    expect(radicalsPresetOf('blue')).toBe('blue');
    expect(radicalsPresetOf('purple')).toBe(DEFAULT_RADICALS_PRESET);
    expect(radicalsPresetOf(undefined)).toBe(DEFAULT_RADICALS_PRESET);
  });

  describe('radicalsReviewOf', () => {
    it('reads the review of an exercise', () => {
      const review = radicalsReviewOf(JSON.stringify({ review: { aiWords: ['借'], skippedLessons: [] } }));
      expect(review?.aiWords).toEqual(['借']);
      expect(hasReviewItems(review!)).toBeTrue();
    });

    it('is null for text that is not an exercise', () => {
      expect(radicalsReviewOf('Câu hỏi,Đáp án')).toBeNull();
      expect(radicalsReviewOf('{}')).toBeNull();
    });

    it('has nothing to show when every list is empty or missing', () => {
      expect(hasReviewItems(radicalsReviewOf(JSON.stringify({ review: { aiWords: [], pinyinWarnings: null } }))!)).toBeFalse();
    });
  });
});
