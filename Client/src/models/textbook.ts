import { CourseType } from './course-type';
import { HskStandard } from './hsk-standard';

// A book the server holds the curated lesson material of. For these the AI works from the real words of the
// lesson, so no photo is needed. Hand-kept mirror of the registry in Server/internal/csvgen/textbooks.go: keep
// the two lists in step by hand (a book added on one side only gives a wrong hint or a wrong lesson limit here).
export interface Textbook {
  courseType: CourseType;
  // Only for HSK: the standard the book follows. A YCT book has none.
  hskStandard?: HskStandard;
  // Absent for a book with no levels (the English vocabulary review).
  level?: number;
  // The book's lesson count: the server refuses a lesson number above it.
  lessons: number;
  title: string;
  // What the book calls its lessons, "Bài" when absent, and their names, shown after the number in the lesson select.
  lessonUnit?: string;
  lessonNames?: readonly string[];
}

export const DEFAULT_LESSON_UNIT = 'Bài';

export const TEXTBOOKS: readonly Textbook[] = [
  {
    courseType: CourseType.Hsk,
    hskStandard: HskStandard.V2,
    level: 1,
    lessons: 15,
    title: '《HSK标准教程1》'
  },
  {
    courseType: CourseType.Hsk,
    hskStandard: HskStandard.V2,
    level: 2,
    lessons: 15,
    title: '《HSK标准教程2》'
  },
  {
    courseType: CourseType.Hsk,
    hskStandard: HskStandard.V2,
    level: 3,
    lessons: 20,
    title: '《HSK标准教程3》'
  },
  {
    courseType: CourseType.Hsk,
    hskStandard: HskStandard.V3,
    level: 1,
    lessons: 15,
    title: '《新HSK教程1》'
  },
  {
    courseType: CourseType.Hsk,
    hskStandard: HskStandard.V3,
    level: 2,
    lessons: 15,
    title: '《新HSK教程2》'
  },
  {
    courseType: CourseType.Hsk,
    hskStandard: HskStandard.V3,
    level: 3,
    lessons: 18,
    title: '《新HSK教程3》'
  },
  {
    courseType: CourseType.Yct,
    level: 1,
    lessons: 12,
    title: '《YCT标准教程1》'
  },
  {
    courseType: CourseType.Yct,
    level: 6,
    lessons: 15,
    title: '《YCT标准教程6》'
  },
  {
    courseType: CourseType.VocabReview10,
    lessons: 8,
    title: 'Ôn tập từ vựng lớp 10',
    lessonUnit: 'Topic',
    lessonNames: ['The Environment', 'The Family', 'Culture', 'Employment', 'Education', 'Technology', 'Social Issues',
      'Entertainment']
  },
];

// The levels of the course that have a book, lowest first: a quiz is only made from a book, so only these are
// offered. HSK needs the standard to match as well.
export function bookLevels(courseType: CourseType | null, hskStandard: HskStandard | null): number[] {
  return TEXTBOOKS
    .filter(book => book.courseType === courseType && (courseType !== CourseType.Hsk || book.hskStandard === hskStandard))
    .flatMap(book => book.level === undefined ? [] : [book.level])
    .sort((a, b) => a - b);
}

// The book for the chosen course, or undefined when there is none (a course typed in by hand never has one,
// and HSK needs the standard to match as well as the level).
export function textbookFor(courseType: CourseType | null, hskStandard: HskStandard | null,
                            level: number | null): Textbook | undefined {
  if (courseType === null || courseType === CourseType.Other) {
    return undefined;
  }
  return TEXTBOOKS.find(book => book.courseType === courseType && (book.level === undefined || book.level === level)
    && (courseType !== CourseType.Hsk || book.hskStandard === hskStandard));
}
