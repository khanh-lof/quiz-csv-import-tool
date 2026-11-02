import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { RadicalsEdit } from '../models/radicals-edit';
import { RadicalsPageService } from './radicals-page.service';

describe('RadicalsPageService', () => {
  let service: RadicalsPageService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(RadicalsPageService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('names the downloaded file after the job', () => {
    expect(RadicalsPageService.fileName('HSK 3: Bài 5')).toBe('HSK-3-Bài-5-GhepBoThu.html');
  });

  it('loads the table of a job and sends it back to be rebuilt', () => {
    const edit: RadicalsEdit = { words: [], chars: [{ char: '馆', meaning: 'quán', inWords: [], ai: true }], components: [] };
    let loaded: RadicalsEdit | undefined;
    service.edit('a/b').subscribe(answer => loaded = answer);
    const get = http.expectOne('/api/csv/jobs/a%2Fb/radicals');
    expect(get.request.method).toBe('GET');
    get.flush(edit);
    expect(loaded).toEqual(edit);

    service.revise('a/b', edit).subscribe();
    const put = http.expectOne('/api/csv/jobs/a%2Fb/radicals');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual(edit);
    put.flush({});
  });
});
