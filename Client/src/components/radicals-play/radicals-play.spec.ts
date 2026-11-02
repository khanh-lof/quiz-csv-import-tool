import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, fakeAsync, TestBed, tick } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { ModalOptions, NzModalService } from 'ng-zorro-antd/modal';
import { Observable, of } from 'rxjs';
import { AiJob } from '../../models/ai-job';
import { ExportType } from '../../models/export-type';
import { RadicalsEdit } from '../../models/radicals-edit';
import { AiJobService } from '../../services/ai-job.service';
import { RadicalsPlay, reviewLines } from './radicals-play';

describe('reviewLines', () => {
  it('writes one line per kind of item and leaves the empty kinds out', () => {
    const lines = reviewLines({
      aiWords: ['借', '还'],
      uncertainWords: [],
      droppedWords: null,
      aiChars: ['借'],
      aiComponents: null,
      pinyinWarnings: [{ lesson: 1, word: '还', char: '还', syllable: 'hǎi', readings: ['hái', 'huán'] }],
      skippedLessons: [{ lesson: 2, usableWordCount: 4, unusableWords: ['一'] }],
      missingGlyphs: [],
    });
    expect(lines.map(line => line.label)).toEqual([
      'Pinyin, nghĩa do AI điền', 'Pinyin cần xem (bài 1)', 'Bài 2 bị bỏ', 'Nghĩa chữ do AI điền'
    ]);
    expect(lines[0].text).toBe('借, 还');
    expect(lines[1].text).toBe('还: 还 ghi "hǎi", đọc hái / huán');
  });
});

describe('RadicalsPlay', () => {
  const JOBS = '/api/csv/jobs';
  const PAGE = '/api/csv/jobs/j1/page';
  const EDIT = '/api/csv/jobs/j1/radicals';

  let fixture: ComponentFixture<RadicalsPlay>;
  let http: HttpTestingController;
  let modal: jasmine.SpyObj<NzModalService>;

  function radicalsJob(review: object): AiJob {
    return {
      id: 'j1', status: 'done', title: 'Bài 3', creative: true, exportType: ExportType.Radicals, intelligence: 1,
      imageCount: 0, courseType: null, courseName: '', hskStandard: null, level: null, lessonNumbers: [3],
      csv: JSON.stringify({ version: 1, review }), errorStatus: 0, errorMessage: '', createdAt: '2026-11-02T00:00:00Z',
      finishedAt: '2026-11-02T00:01:00Z', retryable: false, retryUntil: null,
    };
  }

  const firstJob = radicalsJob({
    aiWords: ['借', '图书馆'], pinyinWarnings: [{ lesson: 3, word: '借', char: '借', syllable: 'jiē', readings: ['jiè'] }],
  });

  function table(): RadicalsEdit {
    return {
      words: [
        { hanzi: '借', lessons: [3], pinyin: 'jiē', meaning: 'mượn', ai: true, uncertain: false, dropped: false },
        { hanzi: '图书馆', lessons: [3], pinyin: 'túshūguǎn', meaning: 'thư viện', ai: true, uncertain: true, dropped: false },
        { hanzi: '好人', lessons: [3], pinyin: 'xian', meaning: 'người tốt', ai: true, uncertain: false, dropped: true },
      ],
      chars: [{ char: '馆', meaning: 'quán', inWords: ['图书馆'], ai: true }],
      components: [{ component: '饣', name: 'Thực', pinyin: 'shí', meaning: 'ăn', inChars: ['馆'], ai: true }],
    };
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RadicalsPlay],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ jobId: 'j1' })) } },
        { provide: NzNotificationService, useValue: jasmine.createSpyObj('NzNotificationService', ['success', 'error']) },
      ],
    });
    modal = jasmine.createSpyObj<NzModalService>('NzModalService', ['confirm']);
    TestBed.overrideProvider(NzModalService, { useValue: modal });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // The icons are fetched as files from assets/ when first drawn, which is not what these specs are about.
    http.match(request => request.url.startsWith('assets/'));
    http.verify();
  });

  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent?.replace(/\s+/g, ' ') ?? '';
  const frame = () => root().querySelector('iframe')!.getAttribute('srcdoc');
  const input = (label: string) => root().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

  function click(label: string): void {
    const button = Array.from(root().querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.trim() === label);
    expect(button).withContext(label).toBeDefined();
    button!.click();
    fixture.detectChanges();
  }

  function type(label: string, value: string): void {
    const field = input(label);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function open(): void {
    fixture = TestBed.createComponent(RadicalsPlay);
    fixture.detectChanges();
    http.expectOne(JOBS).flush({ jobs: [firstJob] });
    http.expectOne(PAGE).flush('<html>v1</html>');
    fixture.detectChanges();
  }

  function startEdit(answer: RadicalsEdit = table()): void {
    click('Sửa');
    http.expectOne({ method: 'GET', url: EDIT }).flush(answer);
    fixture.detectChanges();
  }

  it('turns the review into a table of inputs', fakeAsync(() => {
    open();
    expect(text()).toContain('Cần xem lại');

    startEdit();
    // ngModel writes the inputs' values a tick later.
    tick();
    expect(text()).not.toContain('Cần xem lại');
    expect(input('Nghĩa của 图书馆').value).toBe('thư viện');
    expect(input('Nghĩa của chữ 馆').value).toBe('quán');
    expect(input('Tên bộ 饣').value).toBe('Thực');
    expect(text()).toContain('借 đọc jiè');
    expect(text()).toContain('AI không chắc');
    expect(text()).toContain('nhập pinyin để đưa vào bài');

    click('Hủy');
    expect(input('Nghĩa của 图书馆')).toBeNull();
    expect(text()).toContain('Cần xem lại');
  }));

  it('asks before throwing typed corrections away', () => {
    open();
    startEdit();
    const component = fixture.componentInstance;
    expect(component.canLeave()).toBeTrue();

    type('Nghĩa của 图书馆', 'nhà sách');
    click('Hủy');
    const options = () => modal.confirm.calls.mostRecent().args[0] as ModalOptions;
    (options().nzOnCancel as () => void)();
    fixture.detectChanges();
    expect(input('Nghĩa của 图书馆')).not.toBeNull();

    let left: boolean | undefined;
    (component.canLeave() as Observable<boolean>).subscribe(leave => left = leave);
    (options().nzOnOk as () => void)();
    expect(left).toBeTrue();

    click('Hủy');
    (options().nzOnOk as () => void)();
    fixture.detectChanges();
    expect(input('Nghĩa của 图书馆')).toBeNull();
    expect(component.canLeave()).toBeTrue();
  });

  it('says the corrections are saved when the rebuilt page does not load', () => {
    open();
    startEdit();
    click('Lưu');
    http.expectOne({ method: 'PUT', url: EDIT }).flush(radicalsJob({}));
    http.expectOne(PAGE).flush('', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    expect(text()).toContain('Đã lưu. Tải lại trang để xem bài mới.');
    expect(root().querySelector('.ant-alert-warning')).not.toBeNull();
    expect(frame()).toBe('<html>v1</html>');
  });

  it('saves the corrections, then shows the rebuilt exercise and its review', () => {
    open();
    startEdit();
    type('Nghĩa của 图书馆', 'nhà sách');
    type('Pinyin của 借', 'jiè');
    click('Lưu');

    const put = http.expectOne({ method: 'PUT', url: EDIT });
    const sent = put.request.body as RadicalsEdit;
    expect(sent.words.find(w => w.hanzi === '图书馆')?.meaning).toBe('nhà sách');
    expect(sent.words.find(w => w.hanzi === '借')?.pinyin).toBe('jiè');
    expect(sent.chars).toEqual(table().chars);

    const revised = radicalsJob({ aiWords: ['图书馆'] });
    put.flush(revised);
    http.expectOne(PAGE).flush('<html>v2</html>');
    fixture.detectChanges();

    expect(frame()).toBe('<html>v2</html>');
    expect(input('Nghĩa của 图书馆')).toBeNull();
    expect(text()).not.toContain('Pinyin cần xem');
    expect(TestBed.inject(AiJobService).jobs()[0].csv).toBe(revised.csv);
  });

  it('shows the rows the server could not use and keeps the teacher in the table', () => {
    open();
    startEdit();
    type('Pinyin của 借', 'jiexyz');
    click('Lưu');

    const flagged = table();
    flagged.words[0] = { ...flagged.words[0], pinyin: 'jiexyz', problem: 'pinyin' };
    flagged.chars[0] = { ...flagged.chars[0], meaning: '', problem: 'missing' };
    http.expectOne({ method: 'PUT', url: EDIT }).flush(flagged, { status: 422, statusText: 'Unprocessable Entity' });
    fixture.detectChanges();

    expect(text()).toContain('Sửa các ô đỏ rồi lưu lại.');
    expect(text()).toContain('Pinyin không khớp số chữ');
    expect(text()).toContain('Chưa nhập');
    expect(frame()).toBe('<html>v1</html>');

    // Typing in a flagged box takes its mark away until the next save.
    type('Pinyin của 借', 'jiè');
    expect(text()).not.toContain('Pinyin không khớp số chữ');
  });

  it('says why a table cannot be loaded or saved', () => {
    open();
    click('Sửa');
    http.expectOne(EDIT).flush('Job cannot be edited.', { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();
    expect(text()).toContain('Bài này tạo trước khi có chức năng sửa.');

    startEdit();
    click('Lưu');
    http.expectOne({ method: 'PUT', url: EDIT }).flush('No lesson has enough words for a group.', { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();
    expect(text()).toContain('Không bài nào còn đủ từ để ghép bộ.');
    expect(input('Nghĩa của 图书馆')).not.toBeNull();
  });
});
