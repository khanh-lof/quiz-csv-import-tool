import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AiCsvService } from './ai-csv.service';

const URL = '/api/csv/generate-from-image';
// Longer than any backoff the service waits between retries.
const RETRY_WAIT_MS = 10_000;

describe('AiCsvService retries', () => {
  let service: AiCsvService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({providers: [provideHttpClient(), provideHttpClientTesting()]});
    service = TestBed.inject(AiCsvService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function fail(status: number): void {
    http.expectOne(URL).flush('error', {status, statusText: 'Error'});
  }

  it('retries 502 and 503, reporting each retry, then succeeds', fakeAsync(() => {
    const retries: number[] = [];
    let result: string | undefined;
    service.generateCsvFromImages([], n => retries.push(n)).subscribe(csv => result = csv);

    fail(502);
    tick(RETRY_WAIT_MS);
    fail(503);
    tick(RETRY_WAIT_MS);
    http.expectOne(URL).flush('Câu hỏi,Đáp án\n你,bạn');

    expect(retries).toEqual([1, 2]);
    expect(result).toBe('Câu hỏi,Đáp án\n你,bạn');
  }));

  it('gives up after two retries', fakeAsync(() => {
    let status: number | undefined;
    service.generateCsvFromImages([]).subscribe({error: err => status = err.status});

    fail(502);
    tick(RETRY_WAIT_MS);
    fail(502);
    tick(RETRY_WAIT_MS);
    fail(502);

    expect(status).toBe(502);
  }));

  it('retries a timeout only once', fakeAsync(() => {
    let status: number | undefined;
    service.generateCsvFromImages([]).subscribe({error: err => status = err.status});

    fail(504);
    tick(RETRY_WAIT_MS);
    fail(504);
    tick(RETRY_WAIT_MS);

    expect(status).toBe(504);
  }));

  for (const status of [400, 401, 403, 413, 500]) {
    it(`does not retry ${status}`, fakeAsync(() => {
      let got: number | undefined;
      service.generateCsvFromImages([]).subscribe({error: err => got = err.status});

      fail(status);
      tick(RETRY_WAIT_MS);

      expect(got).toBe(status);
    }));
  }
});
