import { CourseType } from './course-type';
import { HskStandard } from './hsk-standard';

// A book the server holds the curated lesson material of. For these the AI works from the real words of the
// lesson, so no photo is needed. Hand-kept mirror of the registry in Server/internal/csvgen/textbooks.go: keep
// the two lists in step by hand (a book added on one side only gives a wrong hint or a wrong lesson limit here).
export interface Textbook {
  courseType: CourseType;
  // Only for HSK: the standard the book follows. A YCT book has none.
  hskStandard?: HskStandard;
  level: number;
  // The book's lesson count: the server refuses a lesson number above it.
  lessons: number;
  title: string;
}

export const TEXTBOOKS: readonly Textbook[] = [
  {courseType: CourseType.Hsk, hskStandard: HskStandard.V3, level: 1, lessons: 15, title: '《新HSK教程1》'},
  {courseType: CourseType.Hsk, hskStandard: HskStandard.V3, level: 2, lessons: 15, title: '《新HSK教程2》'},
  {courseType: CourseType.Hsk, hskStandard: HskStandard.V3, level: 3, lessons: 18, title: '《新HSK教程3》'},
  {courseType: CourseType.Yct, level: 6, lessons: 15, title: '《YCT标准教程6》'},
];

// The book for the chosen course, or undefined when there is none (a course typed in by hand never has one,
// and HSK needs the standard to match as well as the level).
export function textbookFor(courseType: CourseType | null, hskStandard: HskStandard | null,
                            level: number | null): Textbook | undefined {
  if (courseType === null || level === null || courseType === CourseType.Other) {
    return undefined;
  }
  return TEXTBOOKS.find(book => book.courseType === courseType && book.level === level
    && (courseType !== CourseType.Hsk || book.hskStandard === hskStandard));
}
