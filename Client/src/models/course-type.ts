export enum CourseType {
  Hsk,
  Yct,
  Other,
  // The English "Ôn tập từ vựng lớp 10" vocabulary review: one book, no levels.
  VocabReview10
}

export function courseHasLevels(courseType: CourseType | null): boolean {
  return courseType !== CourseType.VocabReview10;
}
