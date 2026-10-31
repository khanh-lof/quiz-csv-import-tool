import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpParams, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { FormGroup } from '@angular/forms';
import { AiGeneration } from './ai-generation';
import { CourseType } from '../../models/course-type';
import { HskStandard } from '../../models/hsk-standard';
import { ExportType } from '../../models/export-type';

const SETTINGS_STORAGE_KEY = 'ai-generation-settings';

// The form and the textbook getter are protected: the specs reach them the way the template does.
interface Internals {
  formGroup: FormGroup;
  textbook: { lessons: number } | undefined;
  maxLesson: number;
  lessonOptions: number[];
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
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
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
  const hint = () => (fixture.nativeElement as HTMLElement).querySelector('.export-hint')?.textContent ?? '';

  it('starts on HSK 3.0, the standard of the textbooks', () => {
    expect(page.formGroup.get('hskStandard')?.value).toBe(HskStandard.V3);
  });

  it('caps the lesson at the textbook\'s lesson count and says the book is used', () => {
    fill({
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 3,
      lessonNumbers: [18]
    });

    expect(page.maxLesson).toBe(18);
    expect(page.formGroup.valid).toBeTrue();
    expect(hint()).toContain('《新HSK教程3》');
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

  it('keeps the old limit of 100 and the plain hint for a course without a book', () => {
    fill({
      courseType: CourseType.Yct,
      level: 5,
      lessonNumbers: [40]
    });

    expect(page.maxLesson).toBe(100);
    expect(page.formGroup.valid).toBeTrue();
    expect(hint()).toContain('Chưa có giáo trình');
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
});
