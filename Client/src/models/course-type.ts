export enum CourseType {
  Hsk,
  Yct,
  Other,
  // The English "Ôn tập từ vựng lớp 10" vocabulary review: one book, no levels.
  VocabReview10,
  // The English "Tiếng Anh Global Success" school series: one book per grade, the grade being the level.
  GlobalSuccess
}

// A school series is levelled by grade, so its level reads "lớp" rather than "cấp".
export function courseLevelIsGrade(courseType: CourseType | null): boolean {
  return courseType === CourseType.GlobalSuccess;
}

export function courseHasLevels(courseType: CourseType | null): boolean {
  return courseType !== CourseType.VocabReview10;
}
