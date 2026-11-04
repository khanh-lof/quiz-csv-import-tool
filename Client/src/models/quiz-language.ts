import { CourseType } from './course-type';
import { ExportType } from './export-type';

// The language a quiz teaches. Sent over the wire by ordinal: keep the order identical to Language in
// Server/internal/csvgen/language.go. A request without one is Chinese, as every request was before English.
export enum QuizLanguage {
  Chinese,
  English
}

export interface CourseOption {
  value: CourseType;
  label: string;
}

export interface LanguageSpec {
  value: QuizLanguage;
  label: string;
  // Shown before the label on the page's switch, so the chosen language reads at a glance.
  tag: string;
  // The courses of the language, listed before "Khác" (a course typed in by hand), which every language has.
  // Mirrors courseLanguages on the server: a course listed under the wrong language is refused there.
  courses: readonly CourseOption[];
  // The course the form picks when it must replace one of the other language, null to leave the choice to the teacher.
  defaultCourse: CourseType | null;
  // The formatted mode, which asks for each word of the photos from its Vietnamese meaning.
  formattedLabel: string;
  formattedGuide: string;
}

export const LANGUAGES: readonly LanguageSpec[] = [
  {
    value: QuizLanguage.Chinese,
    label: 'Tiếng Trung',
    tag: '中',
    courses: [
      { value: CourseType.Hsk, label: 'HSK' },
      { value: CourseType.Yct, label: 'YCT' }
    ],
    defaultCourse: null,
    formattedLabel: 'Hỏi chữ Hán',
    formattedGuide: 'Tiếng Việt + pinyin + chữ Hán'
  },
  {
    value: QuizLanguage.English,
    label: 'Tiếng Anh',
    tag: 'EN',
    courses: [
      { value: CourseType.VocabReview10, label: 'Ôn tập từ vựng lớp 10' }
    ],
    defaultCourse: CourseType.Other,
    formattedLabel: 'Hỏi từ tiếng Anh',
    formattedGuide: 'Tiếng Việt + từ tiếng Anh'
  }
];

// Platforms built from what only Chinese has: "Ghép bộ thủ" takes characters apart into their components.
const CHINESE_ONLY_EXPORT_TYPES: readonly ExportType[] = [ExportType.Radicals];

export function languageSpec(language: QuizLanguage | null): LanguageSpec {
  return LANGUAGES.find(spec => spec.value === language) ?? LANGUAGES[0];
}

// The saved or received language, Chinese for anything that is not one.
export function quizLanguageOf(value: unknown): QuizLanguage {
  return LANGUAGES.some(spec => spec.value === value) ? value as QuizLanguage : QuizLanguage.Chinese;
}

export function teachesCourse(language: QuizLanguage | null, courseType: CourseType | null): boolean {
  return courseType === CourseType.Other || languageSpec(language).courses.some(course => course.value === courseType);
}

export function offersExportType(language: QuizLanguage | null, exportType: ExportType | null): boolean {
  return exportType === null || language === QuizLanguage.Chinese || !CHINESE_ONLY_EXPORT_TYPES.includes(exportType);
}
