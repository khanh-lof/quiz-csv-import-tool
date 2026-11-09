import { provideNzI18n } from 'ng-zorro-antd/i18n';
import { appLocale } from '../../i18n/app-locale';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpParams, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { WritableSignal } from '@angular/core';
import { FormGroup } from '@angular/forms';
import { AiGeneration } from './ai-generation';
import { CourseType } from '../../models/course-type';
import { HskStandard } from '../../models/hsk-standard';
import { ExportType } from '../../models/export-type';
import { QuizLanguage } from '../../models/quiz-language';
import { AIGenerationMode } from '../../models/aigeneration-mode';

const SETTINGS_STORAGE_KEY = 'ai-generation-settings';

// The form and the textbook getter are protected: the specs reach them the way the template does.
interface Internals {
  formGroup: FormGroup;
  textbook: { lessons: number } | undefined;
  maxLesson: number;
  lessonOptions: number[];
  selectedImages: WritableSignal<{ file: File; preview: string }[]>;
  generate(): Promise<void>;
}

describe('AiGeneration', () => {
  let fixture: ComponentFixture<AiGeneration>;
  let page: Internals;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.removeItem(SETTINGS_STORAGE_KEY);
    TestBed.configureTestingModule({
      imports: [AiGeneration],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNzI18n(appLocale)],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AiGeneration);
    page = fixture.componentInstance as unknown as Internals;
    fixture.detectChanges();
  });

  afterEach(() => {
    // The icons are fetched as files from assets/ when first drawn, which is not what these specs are about.
    http.match(request => request.url.startsWith('assets/'));
    http.verify();
    localStorage.removeItem(SETTINGS_STORAGE_KEY);
  });

  function fill(values: {
    courseType: CourseType;
    hskStandard?: HskStandard;
    level: number;
    lessonNumbers: number[]
  }): void {
    page.formGroup.patchValue({ exportType: ExportType.Wayground, ...values });
    fixture.detectChanges();
  }

  const lessonErrors = () => page.formGroup.get('lessonNumbers')?.errors;
  const photosShut = () => (fixture.nativeElement as HTMLElement).querySelector('.drop-zone')?.getAttribute('aria-disabled') === 'true';

  it('starts on HSK 3.0, the standard of the textbooks', () => {
    expect(page.formGroup.get('hskStandard')?.value).toBe(HskStandard.V3);
  });

  it('caps the lesson at the textbook\'s lesson count and shuts the photos', () => {
    fill({
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 3,
      lessonNumbers: [18]
    });

    expect(page.maxLesson).toBe(18);
    expect(page.formGroup.valid).toBeTrue();
    expect(photosShut()).toBeTrue();
    expect((fixture.nativeElement as HTMLElement).querySelector('.drop-zone')?.getAttribute('aria-label'))
      .toBe('Ảnh: Có sẵn 《新HSK教程3》, không cần ảnh.');
  });

  it('refuses a lesson past the textbook\'s, such as lesson 18 after switching to level 1', () => {
    fill({
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 3,
      lessonNumbers: [18]
    });
    page.formGroup.patchValue({ level: 1 });

    expect(page.maxLesson).toBe(15);
    expect(lessonErrors()?.['max']).toBeTruthy();
    expect(page.formGroup.invalid).toBeTrue();

    page.formGroup.patchValue({ lessonNumbers: [15] });
    expect(lessonErrors()).toBeNull();
    expect(page.formGroup.valid).toBeTrue();
  });

  it('takes the limit of the other standard\'s book when the standard changes', () => {
    fill({
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 3,
      lessonNumbers: [18]
    });
    expect(page.formGroup.valid).toBeTrue();

    page.formGroup.patchValue({ hskStandard: HskStandard.V2 });
    expect(page.textbook?.lessons).toBe(20);
    expect(page.maxLesson).toBe(20);
    expect(lessonErrors()).toBeNull();

    page.formGroup.patchValue({ level: 1 });
    expect(page.maxLesson).toBe(15);
    expect(lessonErrors()?.['max']).toBeTruthy();
  });

  it('keeps the old limit of 100 and the photos open for a course without a book', () => {
    fill({
      courseType: CourseType.Yct,
      level: 5,
      lessonNumbers: [40]
    });

    expect(page.maxLesson).toBe(100);
    expect(page.formGroup.valid).toBeTrue();
    expect(photosShut()).toBeFalse();
  });

  it('keeps the photos open until a course with a book is picked', () => {
    expect(photosShut()).toBeFalse();

    page.formGroup.patchValue({ courseType: CourseType.Yct, level: 5 });
    fixture.detectChanges();
    expect(photosShut()).toBeFalse();

    page.formGroup.patchValue({ level: 6 });
    fixture.detectChanges();
    expect(photosShut()).toBeTrue();
  });

  it('keeps the photos open for a course typed in by hand', () => {
    page.formGroup.patchValue({ courseType: CourseType.Other });
    fixture.detectChanges();

    expect(photosShut()).toBeFalse();
  });

  it('neither shows nor sends the photos added before a course with a book was picked', async () => {
    page.selectedImages.set([{ file: new File(['x'], 'bai.png', { type: 'image/png' }), preview: 'data:image/png;base64,eA==' }]);
    fill({ courseType: CourseType.Hsk, hskStandard: HskStandard.V3, level: 3, lessonNumbers: [5] });

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.image-item')).toBeNull();
    expect(element.querySelector('.submit-button')?.textContent?.trim()).toBe('Tạo câu hỏi');

    await page.generate();
    const request = http.expectOne(r => r.url === '/api/csv/jobs').request;
    expect(Array.from((request.body as FormData).keys())).toEqual([]);
  });

  it('applies the YCT book\'s lesson count', () => {
    fill({
      courseType: CourseType.Yct,
      level: 6,
      lessonNumbers: [16]
    });

    expect(page.maxLesson).toBe(15);
    expect(lessonErrors()?.['max']).toBeTruthy();
  });

  it('refuses the form when one of several lessons is past the textbook\'s', () => {
    fill({
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 1,
      lessonNumbers: [3, 14, 15]
    });
    expect(lessonErrors()).toBeNull();
    expect(page.formGroup.valid).toBeTrue();

    page.formGroup.patchValue({ lessonNumbers: [3, 15, 16] });
    expect(lessonErrors()?.['max']).toBeTruthy();
    expect(page.formGroup.invalid).toBeTrue();

    page.formGroup.patchValue({ lessonNumbers: [3, 15] });
    expect(lessonErrors()).toBeNull();
    expect(page.formGroup.valid).toBeTrue();
  });

  it('needs at least one lesson in Auto mode', () => {
    fill({
      courseType: CourseType.Yct,
      level: 5,
      lessonNumbers: []
    });

    expect(lessonErrors()?.['required']).toBeTruthy();
    expect(page.formGroup.invalid).toBeTrue();

    page.formGroup.patchValue({ lessonNumbers: [2] });
    expect(lessonErrors()).toBeNull();
  });

  it('offers the lessons of the book, and keeps a chosen lesson past them so it can be removed', () => {
    fill({
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 3,
      lessonNumbers: [17, 18]
    });
    expect(page.lessonOptions).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));

    page.formGroup.patchValue({ level: 1 });
    expect(page.lessonOptions).toEqual([...Array.from({ length: 15 }, (_, index) => index + 1), 17, 18]);

    page.formGroup.patchValue({ lessonNumbers: [3] });
    expect(page.lessonOptions).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
  });

  it('offers 100 lessons for a course without a book', () => {
    fill({
      courseType: CourseType.Yct,
      level: 5,
      lessonNumbers: [1]
    });

    expect(page.lessonOptions.length).toBe(100);
  });

  describe('restoring the saved settings', () => {
    function reopen(saved: object): AiGeneration {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(saved));
      return TestBed.createComponent(AiGeneration).componentInstance;
    }
    const lessonsOf = (component: AiGeneration) =>
      (component as unknown as Internals).formGroup.get('lessonNumbers')?.value;

    it('restores several lessons, sorted and no more than the limit', () => {
      expect(lessonsOf(reopen({ lessonNumbers: [4, 3, 5] }))).toEqual([3, 4, 5]);
      expect(lessonsOf(reopen({ lessonNumbers: [9, 8, 7, 6, 5, 4, 3] }))).toEqual([3, 4, 5, 6, 7]);
    });

    it('starts with none when the save has nothing usable', () => {
      expect(lessonsOf(reopen({ lessonNumbers: 'x' }))).toEqual([]);
      expect(lessonsOf(reopen({}))).toEqual([]);
    });
  });

  describe('sending the request', () => {
    const url = '/api/csv/jobs';

    async function submitWith(lessonNumbers: number[], values: object): Promise<HttpParams> {
      fill({
        courseType: CourseType.Hsk,
        hskStandard: HskStandard.V3,
        level: 3,
        lessonNumbers,
        ...values
      });
      await page.generate();
      return http.expectOne(request => request.url === url).request.params;
    }

    it('names the job after a single lesson', async () => {
      const params = await submitWith([5], {});

      expect(params.get('title')).toBe('HSK3.0-3-Bai5');
      expect(params.get('lessonNumbers')).toBe('5');
    });

    it('names the job after several lessons, a run of three or more shortened', async () => {
      const params = await submitWith([7, 3, 5, 4], {});

      expect(params.get('title')).toBe('HSK3.0-3-Bai3-5+7');
      expect(params.get('lessonNumbers')).toBe('3,4,5,7');
    });

    it('names a course typed in by hand after its lessons', async () => {
      const params = await submitWith([2, 6], { courseType: CourseType.Other, courseName: 'Boya', level: null });

      expect(params.get('title')).toBe('Boya-Bai2+6');
    });
  });

  it('toggles a game with its card, numbers the chosen ones as the quiz will, and needs one', () => {
    fill({ courseType: CourseType.Hsk, hskStandard: HskStandard.V3, level: 1, lessonNumbers: [1] });
    page.formGroup.patchValue({ exportType: ExportType.GestureQuiz, gestureStages: [4, 6] });
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const cards = () => Array.from(element.querySelectorAll<HTMLButtonElement>('.gesture-options .stage-card'));

    expect(cards().length).toBe(6);
    expect(cards().map(card => card.getAttribute('aria-pressed')))
      .toEqual(['false', 'false', 'false', 'true', 'false', 'true']);
    expect(cards().map(card => card.querySelector('.stage-no')?.textContent ?? null))
      .toEqual([null, null, null, 'Màn 1', null, 'Màn 2']);

    cards()[0].click();
    fixture.detectChanges();
    expect(page.formGroup.get('gestureStages')?.value).toEqual([1, 4, 6]);
    expect(cards()[3].querySelector('.stage-no')?.textContent).toBe('Màn 2');

    [0, 3, 5].forEach(index => cards()[index].click());
    fixture.detectChanges();
    expect(page.formGroup.get('gestureStages')?.value).toEqual([]);
    expect(page.formGroup.valid).toBeFalse();
    expect(element.querySelector('.gesture-options .text-error')?.textContent).toContain('Chọn ít nhất 1 trò chơi');
  });

  it('asks only for the course and the lessons for "Ghép bộ thủ"', async () => {
    page.formGroup.patchValue({
      courseType: CourseType.Other,
      courseName: 'Boya',
      level: null,
      lessonNumbers: [4, 2],
      exportType: ExportType.Radicals
    });
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.gesture-options')).toBeNull();
    await page.generate();

    const request = http.expectOne(r => r.url === '/api/csv/jobs').request;
    expect(request.params.get('exportType')).toBe(String(ExportType.Radicals));
    expect(request.params.get('lessonNumbers')).toBe('2,4');
    expect(Array.from((request.body as FormData).keys())).toEqual([]);
  });

  describe('the language', () => {
    const element = (): HTMLElement => fixture.nativeElement;
    const control = (name: string) => page.formGroup.get(name)!;
    const chooseLanguage = (label: string): void => {
      const radio = Array.from(element().querySelectorAll<HTMLElement>('.page-toolbar label[nz-radio-button]'))
        .find(candidate => candidate.textContent?.includes(label))!;
      radio.querySelector('input')!.click();
      fixture.detectChanges();
    };

    it('is chosen on the left of the guide button, Chinese first, each with its tag', () => {
      const toolbar = element().querySelector('.page-toolbar')!;
      expect(toolbar.children.length).toBe(2);
      expect(toolbar.firstElementChild?.classList).toContain('page-choices');
      expect(toolbar.lastElementChild?.tagName.toLowerCase()).toBe('kt-quiz-usage-guide');
      const languageSwitch = toolbar.querySelector('.page-choices')!.firstElementChild!;
      expect(Array.from(languageSwitch.querySelectorAll('label[nz-radio-button]')).map(label => label.textContent?.replace(/\s+/g, '')))
        .toEqual(['中TiếngTrung', 'ENTiếngAnh']);
      expect(control('language').value).toBe(QuizLanguage.Chinese);
      expect(element().textContent).toContain('Hỏi chữ Hán');
    });

    it('drops the Chinese course and platform for English and picks the course typed in by hand', () => {
      page.formGroup.patchValue({ courseType: CourseType.Hsk, exportType: ExportType.Radicals });

      chooseLanguage('Tiếng Anh');

      expect(control('language').value).toBe(QuizLanguage.English);
      expect(control('courseType').value).toBe(CourseType.Other);
      expect(control('exportType').value).toBeNull();
      expect(element().textContent).toContain('Hỏi từ tiếng Anh');
      expect(element().querySelector('.course-name-input')).not.toBeNull();
    });

    it('names the topics of the vocabulary review, which has no level', () => {
      chooseLanguage('Tiếng Anh');
      page.formGroup.patchValue({ courseType: CourseType.VocabReview10 });
      fixture.detectChanges();

      expect(element().querySelector('label[for="level"]')).toBeNull();
      expect(element().querySelector('label[for="lessonNumbers"]')?.textContent?.trim()).toBe('Topic');
      expect((page as any).lessonOptionLabel(3)).toBe('3. Culture');
      expect(control('level').hasError('required')).toBeFalse();
    });

    it('gives each language back its own choices', () => {
      page.formGroup.patchValue({ courseType: CourseType.Hsk, level: 2, lessonNumbers: [4], exportType: ExportType.Radicals });

      chooseLanguage('Tiếng Anh');
      expect(control('level').value).toBeNull();
      expect(control('lessonNumbers').value).toEqual([]);
      page.formGroup.patchValue({ courseName: 'Solutions', level: 3, lessonNumbers: [1], exportType: ExportType.GimKit });

      chooseLanguage('Tiếng Trung');
      expect(control('courseType').value).toBe(CourseType.Hsk);
      expect(control('level').value).toBe(2);
      expect(control('lessonNumbers').value).toEqual([4]);
      expect(control('exportType').value).toBe(ExportType.Radicals);

      chooseLanguage('Tiếng Anh');
      expect(control('courseName').value).toBe('Solutions');
      expect(control('level').value).toBe(3);
      expect(control('exportType').value).toBe(ExportType.GimKit);
    });

    it('starts the other language with fresh fields, not with errors left from this one', () => {
      page.formGroup.markAllAsDirty();
      chooseLanguage('Tiếng Anh');

      expect(control('lessonNumbers').dirty).toBeFalse();
      expect(control('AIMode').dirty).toBeTrue();
    });

    it('keeps the mode, which is not a language\'s', () => {
      page.formGroup.patchValue({ AIMode: AIGenerationMode.Formatted });

      chooseLanguage('Tiếng Anh');

      expect(control('AIMode').value).toBe(AIGenerationMode.Formatted);
    });

    it('is sent with the job and remembered', async () => {
      chooseLanguage('Tiếng Anh');
      page.formGroup.patchValue({ courseName: 'Global Success', level: 6, lessonNumbers: [2], exportType: ExportType.GimKit });

      await page.generate();
      const params = http.expectOne(request => request.url === '/api/csv/jobs').request.params;
      expect(params.get('language')).toBe(String(QuizLanguage.English));
      expect(params.get('courseType')).toBe(String(CourseType.Other));
      expect(params.get('title')).toBe('Global Success6-Bai2');
      expect(params.has('intelligence')).toBeFalse();
      const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!);
      expect(saved.language).toBe(QuizLanguage.English);
      expect('intelligence' in saved).toBeFalse();
      expect(saved.byLanguage[QuizLanguage.English].courseName).toBe('Global Success');
      expect(saved.byLanguage[QuizLanguage.Chinese].courseType).toBeNull();
    });

    it('restores the choices of both languages', () => {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
        language: QuizLanguage.English,
        // Saved before "Độ thông minh" was removed: it is not read.
        intelligence: 2,
        byLanguage: {
          [QuizLanguage.Chinese]: { courseType: CourseType.Yct, level: 6, lessonNumbers: [3] },
          [QuizLanguage.English]: { courseType: CourseType.Other, courseName: 'Solutions', lessonNumbers: [2] }
        }
      }));
      fixture = TestBed.createComponent(AiGeneration);
      page = fixture.componentInstance as unknown as Internals;
      fixture.detectChanges();

      expect(control('language').value).toBe(QuizLanguage.English);
      expect(page.formGroup.get('intelligence')).toBeNull();
      expect(control('courseName').value).toBe('Solutions');
      chooseLanguage('Tiếng Trung');
      expect(control('courseType').value).toBe(CourseType.Yct);
      expect(control('level').value).toBe(6);
      expect(control('lessonNumbers').value).toEqual([3]);
    });

    it('fits remembered settings to it', () => {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
        language: QuizLanguage.English,
        courseType: CourseType.Yct,
        exportType: ExportType.Radicals
      }));
      const restored = (TestBed.createComponent(AiGeneration).componentInstance as unknown as Internals).formGroup;

      expect(restored.get('language')?.value).toBe(QuizLanguage.English);
      expect(restored.get('courseType')?.value).toBe(CourseType.Other);
      expect(restored.get('exportType')?.value).toBeNull();
    });
  });
});
