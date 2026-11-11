import { CourseType } from './course-type';
import { ExportType } from './export-type';
import { languageSpec, offersCourse, offersExportType, QuizLanguage, quizLanguageOf, teachesCourse } from './quiz-language';

describe('quiz languages', () => {
  it('keeps the server ordinals', () => {
    expect(QuizLanguage.Chinese).toBe(0);
    expect(QuizLanguage.English).toBe(1);
  });

  it('lists each course under its own language, and the course typed in by hand under every one', () => {
    expect(teachesCourse(QuizLanguage.Chinese, CourseType.Hsk)).toBeTrue();
    expect(teachesCourse(QuizLanguage.Chinese, CourseType.Yct)).toBeTrue();
    expect(teachesCourse(QuizLanguage.English, CourseType.Hsk)).toBeFalse();
    expect(teachesCourse(QuizLanguage.English, CourseType.Yct)).toBeFalse();
    expect(teachesCourse(QuizLanguage.English, CourseType.Other)).toBeTrue();
    expect(teachesCourse(QuizLanguage.English, CourseType.VocabReview10)).toBeTrue();
    expect(teachesCourse(QuizLanguage.Chinese, CourseType.VocabReview10)).toBeFalse();
    expect(teachesCourse(QuizLanguage.Chinese, CourseType.Other)).toBeTrue();
    expect(teachesCourse(QuizLanguage.English, null)).toBeFalse();
  });

  it('offers a quiz only for the courses of the language, never the one typed in by hand', () => {
    expect(offersCourse(QuizLanguage.Chinese, CourseType.Hsk)).toBeTrue();
    expect(offersCourse(QuizLanguage.Chinese, CourseType.Yct)).toBeTrue();
    expect(offersCourse(QuizLanguage.English, CourseType.VocabReview10)).toBeTrue();
    expect(offersCourse(QuizLanguage.Chinese, CourseType.Other)).toBeFalse();
    expect(offersCourse(QuizLanguage.English, CourseType.Other)).toBeFalse();
    expect(offersCourse(QuizLanguage.English, CourseType.Hsk)).toBeFalse();
    expect(offersCourse(QuizLanguage.Chinese, null)).toBeFalse();
  });

  it('offers "Ghép bộ thủ" for Chinese only', () => {
    expect(offersExportType(QuizLanguage.Chinese, ExportType.Radicals)).toBeTrue();
    expect(offersExportType(QuizLanguage.English, ExportType.Radicals)).toBeFalse();
    expect(offersExportType(QuizLanguage.English, ExportType.GestureQuiz)).toBeTrue();
    expect(offersExportType(QuizLanguage.English, null)).toBeTrue();
  });

  it('reads anything that is not a language as Chinese', () => {
    expect(quizLanguageOf(QuizLanguage.English)).toBe(QuizLanguage.English);
    expect(quizLanguageOf(undefined)).toBe(QuizLanguage.Chinese);
    expect(quizLanguageOf(7)).toBe(QuizLanguage.Chinese);
    expect(quizLanguageOf('1')).toBe(QuizLanguage.Chinese);
    expect(languageSpec(null).value).toBe(QuizLanguage.Chinese);
  });
});
