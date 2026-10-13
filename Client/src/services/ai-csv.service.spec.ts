import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AiCsvService } from './ai-csv.service';
import { AIGenerationMode } from '../models/aigeneration-mode';
import { CourseType } from '../models/course-type';
import { ExportType } from '../models/export-type';
import { HskStandard } from '../models/hsk-standard';

const URL = '/api/csv/jobs';

// Retrying is the server's job (it retries the LLM gateway while it works on the job), so the service
// must send each submission exactly once and hand any failure straight to the page.
describe('AiCsvService', () => {
  let service: AiCsvService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({providers: [provideHttpClient(), provideHttpClientTesting()]});
    service = TestBed.inject(AiCsvService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('returns the id the server answered for a formatted job', () => {
    let result: string | undefined;
    service.submitFormatted([], 'Từ ảnh').subscribe(job => result = job.id);

    const req = http.expectOne(r => r.url === URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.params.get('title')).toBe('Từ ảnh');
    expect(req.request.params.has('isCreative')).toBeFalse();
    req.flush({id: 'abc'});

    expect(result).toBe('abc');
  });

  it('sends the lesson of a creative job as query parameters', () => {
    service.submitCreative([], {
      courseType: CourseType.Hsk, courseName: 'ignored', hskStandard: HskStandard.V3, level: 4, lessonNumber: 5,
      AIMode: AIGenerationMode.Auto, exportType: ExportType.Wayground, intelligence: 2,
    }, 'HSK3.0-4-Bai5').subscribe();

    const params = http.expectOne(r => r.url === URL).request.params;
    expect(params.get('title')).toBe('HSK3.0-4-Bai5');
    expect(params.get('isCreative')).toBe('true');
    expect(params.get('exportType')).toBe(String(ExportType.Wayground));
    expect(params.get('courseType')).toBe(String(CourseType.Hsk));
    expect(params.get('hskStandard')).toBe(String(HskStandard.V3));
    expect(params.get('level')).toBe('4');
    expect(params.get('lessonNumber')).toBe('5');
    expect(params.get('intelligence')).toBe('2');
    expect(params.has('courseName')).toBeFalse();
  });

  for (const status of [400, 401, 403, 413, 500, 502, 503, 504]) {
    it(`does not re-send after ${status}`, () => {
      let got: number | undefined;
      service.submitFormatted([], 'x').subscribe({error: err => got = err.status});

      http.expectOne(r => r.url === URL).flush('error', {status, statusText: 'Error'});

      expect(got).toBe(status);
    });
  }

  it('cleans the model answer of code fences and leading prose', () => {
    expect(service.extractCsvContent('```csv\na,b\n```')).toBe('a,b');
    expect(service.extractCsvContent('Here you go\nCâu hỏi,Đáp án\nx,y')).toBe('Câu hỏi,Đáp án\nx,y');
    expect(service.extractCsvContent('  a,b  ')).toBe('a,b');
    expect(service.extractCsvContent('')).toBe('');
  });
});
