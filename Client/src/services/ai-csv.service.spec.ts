import { TestBed } from '@angular/core/testing';
import { HttpInterceptorFn, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AiCsvService, ImageUploadError } from './ai-csv.service';
import { AIGenerationMode } from '../models/aigeneration-mode';
import { CourseType } from '../models/course-type';
import { ExportType } from '../models/export-type';
import { HskStandard } from '../models/hsk-standard';
import { QuizLanguage } from '../models/quiz-language';

const URL = '/api/csv/jobs';

// Retrying is the server's job (it retries the LLM gateway while it works on the job), so the service
// must send each submission exactly once and hand any failure straight to the page.
describe('AiCsvService', () => {
  let service: AiCsvService;
  let http: HttpTestingController;

  beforeEach(() => {
    // The interceptor stands in for AuthInterceptor: the access token must not reach the image store.
    const addToken: HttpInterceptorFn = (req, next) => next(req.clone({ setHeaders: { Authorization: 'Bearer t' } }));
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([addToken])), provideHttpClientTesting()],
    });
    service = TestBed.inject(AiCsvService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('returns the id the server answered for a formatted job', () => {
    let result: string | undefined;
    service.submitFormatted([], 'Hỏi chữ Hán', QuizLanguage.Chinese).subscribe(job => result = job.id);

    const req = http.expectOne(r => r.url === URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.params.get('title')).toBe('Hỏi chữ Hán');
    expect(req.request.params.get('language')).toBe(String(QuizLanguage.Chinese));
    expect(req.request.params.has('isCreative')).toBeFalse();
    req.flush({ id: 'abc' });

    expect(result).toBe('abc');
  });

  it('sends the lesson of a creative job as query parameters', () => {
    service.submitCreative([], {
      language: QuizLanguage.Chinese,
      courseType: CourseType.Hsk,
      courseName: 'ignored',
      hskStandard: HskStandard.V3,
      level: 4,
      lessonNumbers: [5],
      AIMode: AIGenerationMode.Auto,
      exportType: ExportType.Wayground,
      gestureStages: [1, 3],
      questionsPerStage: 7,
    }, 'HSK3.0-4-Bai5').subscribe();

    const params = http.expectOne(r => r.url === URL).request.params;
    expect(params.get('title')).toBe('HSK3.0-4-Bai5');
    expect(params.get('isCreative')).toBe('true');
    expect(params.get('language')).toBe(String(QuizLanguage.Chinese));
    expect(params.get('exportType')).toBe(String(ExportType.Wayground));
    expect(params.get('courseType')).toBe(String(CourseType.Hsk));
    expect(params.get('hskStandard')).toBe(String(HskStandard.V3));
    expect(params.get('level')).toBe('4');
    expect(params.get('lessonNumbers')).toBe('5');
    expect(params.has('lessonNumber')).toBeFalse();
    expect(params.has('intelligence')).toBeFalse();
    expect(params.has('courseName')).toBeFalse();
  });

  it('sends the language of an English job, and Chinese when none is set', () => {
    service.submitCreative([], {
      language: QuizLanguage.English,
      courseType: CourseType.Other,
      courseName: 'Global Success',
      hskStandard: HskStandard.V3,
      level: 6,
      lessonNumbers: [2],
      AIMode: AIGenerationMode.Auto,
      exportType: ExportType.GestureQuiz,
      gestureStages: null,
      questionsPerStage: null,
    }, 'Global Success6-Bai2').subscribe();
    const params = http.expectOne(r => r.url === URL).request.params;
    expect(params.get('language')).toBe(String(QuizLanguage.English));
    expect(params.get('courseName')).toBe('Global Success');
    expect(params.has('hskStandard')).toBeFalse();

    service.submitFormatted([], 'Từ (1 ảnh)', QuizLanguage.English).subscribe();
    expect(http.expectOne(r => r.url === URL).request.params.get('language')).toBe(String(QuizLanguage.English));
  });

  describe('the lessons', () => {
    const lessonsRequest = (lessonNumbers: number[]) => ({
      language: null,
      courseType: CourseType.Yct,
      courseName: null,
      hskStandard: null,
      level: 6,
      lessonNumbers,
      AIMode: AIGenerationMode.Auto,
      exportType: ExportType.Wayground,
      gestureStages: null,
      questionsPerStage: null,
    });

    it('sends several lessons in ascending order, whatever order they were picked in', () => {
      service.submitCreative([], lessonsRequest([7, 3, 5, 4]), 'YCT6-Bai3-5+7').subscribe();

      expect(http.expectOne(r => r.url === URL).request.params.get('lessonNumbers')).toBe('3,4,5,7');
    });

    it('does not change the list it was given', () => {
      const lessons = [5, 2];
      service.submitCreative([], lessonsRequest(lessons), 'YCT6-Bai2+5').subscribe();
      http.expectOne(r => r.url === URL);

      expect(lessons).toEqual([5, 2]);
    });
  });

  describe('the gesture quiz options', () => {
    const request = (exportType: ExportType, gestureStages: number[] | null, questionsPerStage: number | null) => ({
      language: QuizLanguage.Chinese,
      courseType: CourseType.Hsk,
      courseName: null,
      hskStandard: HskStandard.V2,
      level: 2,
      lessonNumbers: [3],
      AIMode: AIGenerationMode.Auto,
      exportType,
      gestureStages,
      questionsPerStage,
    });

    it('sends the chosen games in ascending order and the question count for a Game', () => {
      service.submitCreative([], request(ExportType.GestureQuiz, [6, 1, 4], 8), 'HSK2-Bai3').subscribe();

      const params = http.expectOne(r => r.url === URL).request.params;
      expect(params.get('exportType')).toBe(String(ExportType.GestureQuiz));
      expect(params.get('gestureStages')).toBe('1,4,6');
      expect(params.get('questionsPerStage')).toBe('8');
    });

    it('sends a single game as just its number', () => {
      service.submitCreative([], request(ExportType.GestureQuiz, [5], 4), 'HSK2-Bai3').subscribe();

      const params = http.expectOne(r => r.url === URL).request.params;
      expect(params.get('gestureStages')).toBe('5');
      expect(params.get('questionsPerStage')).toBe('4');
    });

    it('does not change the list it was given', () => {
      const stages = [3, 1];
      service.submitCreative([], request(ExportType.GestureQuiz, stages, 5), 'HSK2-Bai3').subscribe();
      http.expectOne(r => r.url === URL);

      expect(stages).toEqual([3, 1]);
    });

    it('leaves out an option that is null, so the server uses its default', () => {
      service.submitCreative([], request(ExportType.GestureQuiz, null, null), 'HSK2-Bai3').subscribe();

      const params = http.expectOne(r => r.url === URL).request.params;
      expect(params.has('gestureStages')).toBeFalse();
      expect(params.has('questionsPerStage')).toBeFalse();
    });

    for (const exportType of [ExportType.GimKit, ExportType.Blooket, ExportType.Wayground]) {
      it(`sends neither for ${ExportType[exportType]}, whatever the form holds`, () => {
        service.submitCreative([], request(exportType, [1, 2, 3], 6), 'HSK2-Bai3').subscribe();

        const params = http.expectOne(r => r.url === URL).request.params;
        expect(params.has('gestureStages')).toBeFalse();
        expect(params.has('questionsPerStage')).toBeFalse();
      });
    }

    it('sends neither with a formatted job', () => {
      service.submitFormatted([], 'Hỏi chữ Hán', QuizLanguage.Chinese).subscribe();

      const params = http.expectOne(r => r.url === URL).request.params;
      expect(params.has('gestureStages')).toBeFalse();
      expect(params.has('questionsPerStage')).toBeFalse();
    });
  });

  describe('images', () => {
    const files = [new File(['a'], 'a.jpg', { type: 'image/jpeg' }), new File(['b'], 'b.jpg', { type: 'image/jpeg' })];
    const grant = {
      url: 'https://api.cloudinary.test/v1_1/demo/image/upload',
      uploads: [
        { publicId: 'quiztool-jobs/1', fields: { api_key: 'key', public_id: 'quiztool-jobs/1', signature: 's1' } },
        { publicId: 'quiztool-jobs/2', fields: { api_key: 'key', public_id: 'quiztool-jobs/2', signature: 's2' } },
      ],
    };

    it('uploads them to the image store, signed, and sends their ids with the job', () => {
      let result: string | undefined;
      service.submitFormatted(files, 'Từ (2 ảnh)', QuizLanguage.Chinese).subscribe(job => result = job.id);

      const sign = http.expectOne(r => r.url === '/api/csv/uploads');
      expect(sign.request.method).toBe('POST');
      expect(sign.request.params.get('count')).toBe('2');
      sign.flush(grant);

      const uploads = http.match(r => r.url === grant.url);
      expect(uploads.length).toBe(2);
      const first = uploads[0].request.body as FormData;
      expect(first.get('signature')).toBe('s1');
      expect(first.get('public_id')).toBe('quiztool-jobs/1');
      expect((first.get('file') as File).name).toBe('a.jpg');
      expect(uploads[0].request.headers.has('Authorization')).toBeFalse();
      uploads.forEach(upload => upload.flush({}));

      const job = http.expectOne(r => r.url === URL);
      const body = job.request.body as FormData;
      expect(body.getAll('imageId')).toEqual(['quiztool-jobs/1', 'quiztool-jobs/2']);
      expect(body.has('images')).toBeFalse();
      job.flush({ id: 'abc' });
      expect(result).toBe('abc');
    });

    it('sends the images with the job when the server has no image store', () => {
      service.submitFormatted(files, 'Từ (2 ảnh)', QuizLanguage.Chinese).subscribe();

      http.expectOne(r => r.url === '/api/csv/uploads').flush('no', { status: 404, statusText: 'Not Found' });

      const body = http.expectOne(r => r.url === URL).request.body as FormData;
      expect(body.getAll('images').length).toBe(2);
      expect(body.has('imageId')).toBeFalse();
    });

    it('sends no job when an image cannot be uploaded', () => {
      let got: unknown;
      service.submitFormatted(files, 'Từ (2 ảnh)', QuizLanguage.Chinese).subscribe({ error: err => got = err });

      http.expectOne(r => r.url === '/api/csv/uploads').flush(grant);
      http.match(r => r.url === grant.url)[0].flush({ error: { message: 'Invalid Signature' } },
        { status: 401, statusText: 'Unauthorized' });

      expect(got).toBeInstanceOf(ImageUploadError);
      http.match(r => r.url === grant.url);
      http.expectNone(r => r.url === URL);
    });
  });

  for (const status of [400, 401, 403, 413, 500, 502, 503, 504]) {
    it(`does not re-send after ${status}`, () => {
      let got: number | undefined;
      service.submitFormatted([], 'x', QuizLanguage.Chinese).subscribe({ error: err => got = err.status });

      http.expectOne(r => r.url === URL).flush('error', {
        status,
        statusText: 'Error'
      });

      expect(got).toBe(status);
    });
  }

  it('cleans the model answer of code fences and leading prose', () => {
    expect(service.extractCsvContent('```csv\na,b\n```')).toBe('a,b');
    expect(service.extractCsvContent('Here you go\nCâu hỏi,Đáp án\nx,y')).toBe('Câu hỏi,Đáp án\nx,y');
    expect(service.extractCsvContent('  a,b  ')).toBe('a,b');
    expect(service.extractCsvContent('')).toBe('');
  });

  it('sends only the lesson for "Ghép bộ thủ"', () => {
    service.submitCreative([], {
      language: QuizLanguage.Chinese,
      courseType: CourseType.Other,
      courseName: 'Boya',
      hskStandard: null,
      level: null,
      lessonNumbers: [3, 4],
      AIMode: AIGenerationMode.Auto,
      exportType: ExportType.Radicals,
      gestureStages: [1],
      questionsPerStage: 5,
    }, 'Boya-Bai3-4').subscribe();

    const req = http.expectOne(r => r.url === URL);
    expect(req.request.params.get('exportType')).toBe(String(ExportType.Radicals));
    expect(req.request.params.get('courseName')).toBe('Boya');
    expect(req.request.params.get('lessonNumbers')).toBe('3,4');
    expect(req.request.params.has('gestureStages')).toBeFalse();
    expect(Array.from((req.request.body as FormData).keys())).toEqual([]);
  });
});
