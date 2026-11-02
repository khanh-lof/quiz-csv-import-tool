// "Ghép bộ thủ" (ExportType.Radicals): the exercise page in which the learner completes each character by picking
// its missing component. The server builds it from the lesson's words (package radicals); this is the review data
// the job's JSON carries.

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
