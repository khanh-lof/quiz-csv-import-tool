import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
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
    lessonNumber: number
  }): void {
    page.formGroup.patchValue({ exportType: ExportType.Wayground, ...values });
    fixture.detectChanges();
  }

  const lessonErrors = () => page.formGroup.get('lessonNumber')?.errors;
  const hint = () => (fixture.nativeElement as HTMLElement).querySelector('.export-hint')?.textContent ?? '';

  it('starts on HSK 3.0, the standard of the textbooks', () => {
    expect(page.formGroup.get('hskStandard')?.value).toBe(HskStandard.V3);
  });

  it('caps the lesson at the textbook\'s lesson count and says the book is used', () => {
    fill({
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 3,
      lessonNumber: 18
    });

    expect(page.maxLesson).toBe(18);
    expect(page.formGroup.valid).toBeTrue();
    expect(hint()).toContain('《新HSK教程3》');
    expect(hint()).toContain('18 bài');
  });

  it('refuses a lesson past the textbook\'s, such as lesson 18 after switching to level 1', () => {
    fill({
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 3,
      lessonNumber: 18
    });
    page.formGroup.patchValue({ level: 1 });

    expect(page.maxLesson).toBe(15);
    expect(lessonErrors()?.['max']).toBeTruthy();
    expect(page.formGroup.invalid).toBeTrue();

    page.formGroup.patchValue({ lessonNumber: 15 });
    expect(lessonErrors()).toBeNull();
    expect(page.formGroup.valid).toBeTrue();
  });

  it('refuses it too when the standard changes to one without a book', () => {
    fill({
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 3,
      lessonNumber: 18
    });
    expect(page.formGroup.valid).toBeTrue();

    // HSK 2.0 has no textbook: the limit goes back to 100 and the error goes away.
    page.formGroup.patchValue({ hskStandard: HskStandard.V2 });
    expect(page.textbook).toBeUndefined();
    expect(page.maxLesson).toBe(100);
    expect(lessonErrors()).toBeNull();
  });

  it('keeps the old limit of 100 and the plain hint for a course without a book', () => {
    fill({
      courseType: CourseType.Yct,
      level: 5,
      lessonNumber: 40
    });

    expect(page.maxLesson).toBe(100);
    expect(page.formGroup.valid).toBeTrue();
    expect(hint()).toContain('Chưa có giáo trình');
  });

  it('applies the YCT book\'s lesson count', () => {
    fill({
      courseType: CourseType.Yct,
      level: 6,
      lessonNumber: 16
    });

    expect(page.maxLesson).toBe(15);
    expect(lessonErrors()?.['max']).toBeTruthy();
  });
});
