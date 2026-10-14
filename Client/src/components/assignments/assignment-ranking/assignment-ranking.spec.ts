import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, discardPeriodicTasks, fakeAsync, TestBed, tick } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { of } from 'rxjs';
import { Assignment, AssignmentDetail, RankedPlayer } from '../../../models/assignment';
import { AssignmentRanking } from './assignment-ranking';

const MINUTE = 60 * 1000;
const ENDPOINT = '/api/assignments/a1';

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function player(overrides: Partial<RankedPlayer>): RankedPlayer {
  return {
    id: 'p1', name: 'Lan', rank: 1, stagesPassed: 2, correct: 10, possible: 10, attempts: 2,
    stages: {
      '1': {correct: 5, total: 5, passed: true, attempts: 1},
      '2': {correct: 5, total: 5, passed: true, attempts: 1},
    },
    joinedAt: iso(-30 * MINUTE), lastPlayedAt: new Date(2026, 9, 14, 8, 5).toISOString(), reachedAt: iso(-5 * MINUTE),
    ...overrides,
  };
}

const LAN = player({});
const MINH = player({
  id: 'p2', name: 'Minh', rank: 2, stagesPassed: 1, correct: 7,
  stages: {'1': {correct: 5, total: 5, passed: true, attempts: 1}, '2': {correct: 2, total: 5, passed: false, attempts: 3}},
});
const HOA = player({
  id: 'p3', name: 'Hoa', rank: null, stagesPassed: 0, correct: 0, attempts: 0, stages: {}, lastPlayedAt: null, reachedAt: null,
});

function detail(overrides: Partial<AssignmentDetail> = {}): AssignmentDetail {
  return {
    id: 'a1', code: 'K7M2X9QD4P', jobId: 'job-1', title: 'HSK1 bài 1', label: 'Lớp 6A', timeMode: 'standard',
    stageCounts: {'1': 5, '2': 5}, createdAt: iso(-60 * MINUTE), closesAt: null, closedAt: null, open: true,
    playerCount: 3, csv: '', players: [LAN, MINH, HOA], ...overrides,
  };
}

// The members of the component these specs call directly instead of through a popconfirm or a dialog.
interface Api {
  closeAssignment(): void;
  openDeadline(mode: 'reopen' | 'schedule'): void;
  saveDeadline(): void;
  removePlayer(player: RankedPlayer): void;
  downloadRanking(): void;
  deadline(): Date | null;
}

describe('AssignmentRanking', () => {
  let http: HttpTestingController;
  let notifications: jasmine.SpyObj<NzNotificationService>;
  let fixture: ComponentFixture<AssignmentRanking>;

  beforeEach(() => {
    notifications = jasmine.createSpyObj('NzNotificationService', ['success', 'warning', 'error']);
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    TestBed.configureTestingModule({
      imports: [AssignmentRanking],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {provide: ActivatedRoute, useValue: {paramMap: of(convertToParamMap({id: 'a1'}))}},
        {provide: NzNotificationService, useValue: notifications},
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const api = () => fixture.componentInstance as unknown as Api;
  // The table adds a row of its own to measure the columns, which is not a student.
  const rows = () => Array.from(root().querySelectorAll<HTMLElement>('tbody tr.ant-table-row'));

  // Opens the page and answers its first request. Must run inside fakeAsync: the page polls with timers.
  function open(first: AssignmentDetail | { status: number; body: string } = detail()): void {
    fixture = TestBed.createComponent(AssignmentRanking);
    fixture.detectChanges();
    tick();
    const request = http.expectOne(ENDPOINT);
    if ('players' in first) {
      request.flush(first);
    } else {
      request.flush(first.body, {status: first.status, statusText: 'x'});
    }
    fixture.detectChanges();
  }

  // Lets the page's timers go, which a fakeAsync test must do before it ends.
  function leave(): void {
    fixture.destroy();
    discardPeriodicTasks();
    // The icons are fetched as files through HttpClient too.
    http.match(request => request.url.startsWith('assets/'));
    http.verify();
  }

  it('shows the header with the quiz, its label, its state and the number of students', fakeAsync(() => {
    open(detail({closesAt: iso(60 * MINUTE)}));

    expect(root().querySelector('.title')?.textContent).toBe('HSK1 bài 1');
    expect(text()).toContain('Lớp 6A');
    expect(text()).toContain('Đang mở · đóng lúc');
    expect(text()).toContain('Thời gian mỗi câu: Bình thường');
    expect(text()).toContain('3 học sinh');
    leave();
  }));

  it('shows the students in the server order, with medals, stage cells and a muted row for who has no result', fakeAsync(() => {
    open();

    const [lan, minh, hoa] = rows();
    expect(rows().length).toBe(3);
    expect(lan.textContent).toContain('🥇');
    expect(lan.textContent).toContain('Lan');
    expect(lan.textContent).toContain('2/2');
    expect(lan.textContent).toContain('10/10');
    expect(lan.textContent).toContain('5/5 ✓');
    expect(lan.textContent).toContain('08:05');
    expect(minh.textContent).toContain('🥈');
    expect(minh.textContent).toContain('2/5');
    expect(minh.textContent).not.toContain('2/5 ✓');
    expect(hoa.classList).toContain('unranked');
    expect(hoa.textContent).toContain('Hoa');
    // No rank, no stage played and no last play time: dashes.
    expect(hoa.textContent?.match(/–/g)?.length).toBe(4);
    leave();
  }));

  it('has a column for every stage the quiz has, headed with the stage icon', fakeAsync(() => {
    open();

    const headers = Array.from(root().querySelectorAll('thead th')).map(th => th.textContent?.trim());
    expect(headers).toEqual(['Hạng', 'Tên', 'Màn đã qua', 'Câu đúng', '👍 Màn 1', '🙆 Màn 2', 'Lần chơi', 'Cập nhật', '']);
    leave();
  }));

  it('heads the stage columns by their position among the stages the assignment has, with the game as title', fakeAsync(() => {
    open(detail({
      stageCounts: {'4': 5, '6': 5},
      players: [player({
        stagesPassed: 1, correct: 9, possible: 10,
        stages: {'4': {correct: 5, total: 5, passed: true, attempts: 1}, '6': {correct: 4, total: 5, passed: false, attempts: 1}},
      })],
    }));

    const stageHeaders = Array.from(root().querySelectorAll<HTMLElement>('thead th')).slice(4, 6);
    expect(stageHeaders.map(th => th.textContent?.trim())).toEqual(['🍉 Màn 1', '🧩 Màn 2']);
    expect(stageHeaders.map(th => th.title)).toEqual(['Chém hoa quả', 'Xếp câu']);
    // The cells follow the columns: the results of stage 4 first, then those of stage 6.
    expect(rows()[0].textContent).toContain('5/5 ✓');
    expect(rows()[0].textContent).toContain('4/5');
    expect(rows()[0].textContent).toContain('1/2');
    leave();
  }));

  it('invites the teacher to share the link when nobody has joined, and shows it while the assignment is open', fakeAsync(() => {
    open(detail({players: []}));

    expect(text()).toContain('Chưa có học sinh nào vào bài. Gửi link hoặc cho học sinh quét mã QR nhé.');
    expect(root().querySelector('app-share-link')).not.toBeNull();
    leave();
  }));

  it('does not offer the link inline when nobody has joined and the assignment is closed', fakeAsync(() => {
    open(detail({players: [], closedAt: iso(-60 * MINUTE)}));

    expect(text()).toContain('Chưa có học sinh nào vào bài.');
    expect(root().querySelector('app-share-link')).toBeNull();
    leave();
  }));

  it('says the assignment was not found, with a way back to the list', fakeAsync(() => {
    open({status: 404, body: 'Assignment not found'});

    expect(text()).toContain('Không tìm thấy bài này');
    expect(root().querySelector('a[href="/assignments"]')).not.toBeNull();
    expect(root().querySelector('tbody')).toBeNull();
    leave();
  }));

  it('says why the first load failed and tries again on its own', fakeAsync(() => {
    open({status: 0, body: ''});

    expect(text()).toContain('Chưa tải được bảng xếp hạng');
    tick(5000);
    http.expectOne(ENDPOINT).flush(detail());
    fixture.detectChanges();

    expect(text()).not.toContain('Chưa tải được bảng xếp hạng');
    expect(rows().length).toBe(3);
    leave();
  }));

  describe('refreshing', () => {
    it('asks again every 5 seconds while the assignment is open', fakeAsync(() => {
      open();

      tick(5000);
      http.expectOne(ENDPOINT).flush(detail({players: [LAN]}));
      fixture.detectChanges();
      expect(rows().length).toBe(1);

      tick(5000);
      http.expectOne(ENDPOINT).flush(detail({players: [LAN, MINH]}));
      fixture.detectChanges();
      expect(rows().length).toBe(2);
      leave();
    }));

    it('keeps asking for the grace period after the assignment closed', fakeAsync(() => {
      open(detail({closedAt: iso(-2 * MINUTE)}));

      tick(5000);
      http.expectOne(ENDPOINT).flush(detail({closedAt: iso(-2 * MINUTE), players: [LAN]}));
      fixture.detectChanges();

      expect(rows().length).toBe(1);
      leave();
    }));

    it('stops asking once the grace period is over, and the button still refreshes by hand', fakeAsync(() => {
      open(detail({closedAt: iso(-10 * MINUTE)}));

      tick(15000);
      http.expectNone(ENDPOINT);

      const button = Array.from(root().querySelectorAll('nz-card button'))
        .find(b => b.textContent?.includes('Làm mới')) as HTMLButtonElement;
      button.click();
      tick();
      http.expectOne(ENDPOINT).flush(detail({closedAt: iso(-10 * MINUTE), players: [LAN]}));
      fixture.detectChanges();
      expect(rows().length).toBe(1);
      leave();
    }));

    it('does not ask while the tab is hidden, and catches up when it is shown again', fakeAsync(() => {
      open();
      const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')!.get as unknown as jasmine.Spy;
      visibility.and.returnValue('hidden');

      tick(15000);
      http.expectNone(ENDPOINT);

      visibility.and.returnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      http.expectOne(ENDPOINT).flush(detail({players: [LAN]}));
      fixture.detectChanges();
      expect(rows().length).toBe(1);
      leave();
    }));

    it('keeps the last ranking and says it is out of date when a refresh fails', fakeAsync(() => {
      open();

      tick(5000);
      http.expectOne(ENDPOINT).flush('boom', {status: 500, statusText: 'Server Error'});
      fixture.detectChanges();
      expect(text()).toContain('Chưa cập nhật được');
      expect(rows().length).toBe(3);
      expect(notifications.error).not.toHaveBeenCalled();

      tick(5000);
      http.expectOne(ENDPOINT).flush(detail());
      fixture.detectChanges();
      expect(text()).not.toContain('Chưa cập nhật được');
      leave();
    }));

    it('shows the not-found card when a refresh finds the assignment deleted', fakeAsync(() => {
      open();

      tick(5000);
      http.expectOne(ENDPOINT).flush('Assignment not found', {status: 404, statusText: 'Not Found'});
      fixture.detectChanges();

      expect(text()).toContain('Không tìm thấy bài này');
      leave();
    }));
  });

  describe('changing the assignment', () => {
    it('closes it, then shows it closed with the students kept and the way to reopen it', fakeAsync(() => {
      open();

      api().closeAssignment();
      const request = http.expectOne(ENDPOINT);
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({closed: true});
      const closed: Assignment = {...detail(), closedAt: iso(0), open: false};
      request.flush(closed);
      fixture.detectChanges();

      expect(text()).toContain('Đã đóng');
      expect(rows().length).toBe(3);
      expect(text()).toContain('Mở lại');
      expect(text()).not.toContain('Hẹn giờ đóng');
      expect(notifications.success).toHaveBeenCalledTimes(1);
      leave();
    }));

    it('reopens with no closing time unless one is picked', fakeAsync(() => {
      open(detail({closedAt: iso(-10 * MINUTE), closesAt: iso(-20 * MINUTE)}));

      api().openDeadline('reopen');
      expect(api().deadline()).toBeNull();
      api().saveDeadline();
      const request = http.expectOne(ENDPOINT);
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({closed: false, closesAt: null});
      request.flush({...detail(), open: true});
      fixture.detectChanges();

      expect(text()).toContain('Đang mở');
      expect(text()).toContain('Hẹn giờ đóng');
      leave();
    }));

    it('schedules from the closing time it already has', fakeAsync(() => {
      const closesAt = iso(30 * MINUTE);
      open(detail({closesAt}));

      api().openDeadline('schedule');
      expect(api().deadline()?.toISOString()).toBe(closesAt);
      const later = new Date(Date.now() + 90 * MINUTE);
      (fixture.componentInstance as unknown as { deadline: { set(date: Date): void } }).deadline.set(later);
      api().saveDeadline();
      const request = http.expectOne(ENDPOINT);
      expect(request.request.body).toEqual({closesAt: later.toISOString()});
      request.flush({...detail(), closesAt: later.toISOString()});
      fixture.detectChanges();

      expect(text()).toContain('Đang mở · đóng lúc');
      leave();
    }));

    it('says what went wrong when a change is refused, and keeps the page as it was', fakeAsync(() => {
      open();

      api().closeAssignment();
      http.expectOne(ENDPOINT).flush('Invalid closing time.', {status: 400, statusText: 'Bad Request'});
      fixture.detectChanges();

      expect(notifications.error).toHaveBeenCalledTimes(1);
      expect(text()).toContain('Đang mở');
      expect(rows().length).toBe(3);
      leave();
    }));

    it('removes a student and then asks for the ranking again', fakeAsync(() => {
      open();

      api().removePlayer(HOA);
      const removal = http.expectOne(`${ENDPOINT}/players/p3`);
      expect(removal.request.method).toBe('DELETE');
      removal.flush(null, {status: 204, statusText: 'No Content'});
      http.expectOne(ENDPOINT).flush(detail({players: [LAN, MINH]}));
      fixture.detectChanges();

      expect(rows().length).toBe(2);
      expect(text()).not.toContain('Hoa');
      leave();
    }));
  });

  describe('downloading the ranking', () => {
    it('saves a CSV named after the quiz and the label', fakeAsync(() => {
      open();
      let blob: Blob | undefined;
      spyOn(URL, 'createObjectURL').and.callFake((object: Blob | MediaSource) => {
        blob = object as Blob;
        return 'blob:ranking';
      });
      spyOn(URL, 'revokeObjectURL');
      let fileName = '';
      spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) {
        fileName = this.download;
      });

      api().downloadRanking();

      expect(blob?.type).toBe('text/csv;charset=utf-8');
      expect(blob?.size).toBeGreaterThan(0);
      expect(fileName).toBe('HSK1-bài-1-Lớp-6A-bang-xep-hang.csv');
      leave();
    }));
  });

  it('copies the link of the assignment', fakeAsync(() => {
    open();
    const writeText = jasmine.createSpy('writeText').and.resolveTo();
    spyOnProperty(navigator, 'clipboard', 'get').and.returnValue({writeText} as unknown as Clipboard);

    const button = Array.from(root().querySelectorAll('button')).find(b => b.textContent?.includes('Sao chép link'))!;
    button.click();
    tick();

    expect(writeText).toHaveBeenCalledOnceWith(`${location.origin}/play/s/K7M2X9QD4P`);
    expect(notifications.success).toHaveBeenCalledTimes(1);
    leave();
  }));

  it('links to the preview of the assignment', fakeAsync(() => {
    open();

    const link = Array.from(root().querySelectorAll('a')).find(a => a.textContent?.includes('Xem thử'))!;
    expect(link.getAttribute('href')).toBe('/play/preview/a1');
    leave();
  }));
});
