import { hasReviewItems, radicalsReviewOf } from './radicals-review';

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
