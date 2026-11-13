import { CourseType } from './course-type';
import { MessageKey, Messages } from '../i18n/messages';
import { ExportType } from './export-type';

// The language a quiz teaches. Sent over the wire by ordinal: keep the order identical to Language in
// Server/internal/csvgen/language.go. A request without one is Chinese, as every request was before English.
export enum QuizLanguage {
  Chinese,
  English
}

export interface CourseOption {
  value: CourseType;
  labelKey: MessageKey;
}

export interface LanguageSpec {
  value: QuizLanguage;
  labelKey: MessageKey;
  // Shown before the label on the page's switch, so the chosen language reads at a glance.
  tag: string;
  // The nz-tag preset colour of the language's tag in the tables.
  tagColor: string;
  // The courses of the language, each with a book; "Khác" (a course typed in by hand) is only in the history, for the
  // jobs made before every quiz needed a book. Mirrors courseLanguages on the server: a course listed under the wrong
  // language is refused there.
  courses: readonly CourseOption[];
  // The course the form picks when it must replace one of the other language, null to leave the choice to the teacher.
  defaultCourse: CourseType | null;
  // The formatted mode, which asks for each word of the photos from its Vietnamese meaning.
  formattedLabelKey: MessageKey;
  formattedGuideKey: MessageKey;
}

export const LANGUAGES: readonly LanguageSpec[] = [
  {
    value: QuizLanguage.Chinese,
    labelKey: 'ai.language.chinese',
    tag: '中',
    tagColor: 'red',
    courses: [
      { value: CourseType.Hsk, labelKey: 'ai.course.hsk' },
      { value: CourseType.Yct, labelKey: 'ai.course.yct' }
    ],
    defaultCourse: null,
    formattedLabelKey: 'ai.language.chineseFormatted',
    formattedGuideKey: 'ai.language.chineseFormattedGuide'
  },
  {
    value: QuizLanguage.English,
    labelKey: 'ai.language.english',
    tag: 'EN',
    tagColor: 'blue',
    courses: [
      { value: CourseType.VocabReview10, labelKey: 'ai.course.vocabReview10' }
    ],
    defaultCourse: CourseType.VocabReview10,
    formattedLabelKey: 'ai.language.englishFormatted',
    formattedGuideKey: 'ai.language.englishFormattedGuide'
  }
];

// Platforms built from what only Chinese has: "Ghép bộ thủ" takes characters apart into their components.
const CHINESE_ONLY_EXPORT_TYPES: readonly ExportType[] = [ExportType.Radicals];

export function languageSpec(language: QuizLanguage | null): LanguageSpec {
  return LANGUAGES.find(spec => spec.value === language) ?? LANGUAGES[0];
}

// The colour and the text of the tag that names a language in the tables, e.g. "中 Tiếng Trung".
export function languageTagColor(language: QuizLanguage | null): string {
  return languageSpec(language).tagColor;
}

export function languageTagText(language: QuizLanguage | null, messages: Messages): string {
  const spec = languageSpec(language);
  return `${spec.tag} ${messages.get(spec.labelKey)}`;
}

// The saved or received language, Chinese for anything that is not one.
export function quizLanguageOf(value: unknown): QuizLanguage {
  return LANGUAGES.some(spec => spec.value === value) ? value as QuizLanguage : QuizLanguage.Chinese;
}

// The courses a quiz can be asked for in the language: its own, never "Khác".
export function offersCourse(language: QuizLanguage | null, courseType: CourseType | null): boolean {
  return languageSpec(language).courses.some(course => course.value === courseType);
}

// The courses the language's jobs can have, "Khác" included for the jobs made before every quiz needed a book.
export function teachesCourse(language: QuizLanguage | null, courseType: CourseType | null): boolean {
  return courseType === CourseType.Other || languageSpec(language).courses.some(course => course.value === courseType);
}

export function offersExportType(language: QuizLanguage | null, exportType: ExportType | null): boolean {
  return exportType === null || language === QuizLanguage.Chinese || !CHINESE_ONLY_EXPORT_TYPES.includes(exportType);
}
