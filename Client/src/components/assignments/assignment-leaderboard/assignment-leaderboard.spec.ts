import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, discardPeriodicTasks, fakeAsync, flush, TestBed, tick } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { of } from 'rxjs';
import { Assignment, AssignmentDetail, LeaderboardEntry } from '../../../models/assignment';
import { AssignmentLeaderboard } from './assignment-leaderboard';

const MINUTE = 60 * 1000;
const ENDPOINT = '/api/assignments/a1';

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function player(overrides: Partial<LeaderboardEntry>): LeaderboardEntry {
  return {
    id: 'p1', name: 'Lan', avatar: 'cat', rank: 1, stagesPassed: 2, correct: 10, possible: 10, attempts: 2,
    stages: {
      '1': {correct: 5, total: 5, passed: true, attempts: 1},
      '2': {correct: 5, total: 5, passed: true, attempts: 1},
    },
    joinedAt: new Date(2026, 9, 14, 7, 30).toISOString(), lastPlayedAt: new Date(2026, 9, 14, 8, 5).toISOString(),
    reachedAt: iso(-5 * MINUTE),
    ...overrides,
  };
}

const LAN = player({});
const MINH = player({
  id: 'p2', name: 'Minh', avatar: 'dog', rank: 2, stagesPassed: 1, correct: 7,
  stages: {'1': {correct: 5, total: 5, passed: true, attempts: 1}, '2': {correct: 2, total: 5, passed: false, attempts: 3}},
});
const HOA = player({
  id: 'p3', name: 'Hoa', avatar: '', rank: null, stagesPassed: 0, correct: 0, attempts: 0, stages: {}, lastPlayedAt: null, reachedAt: null,
});
// Minh overtakes Lan: the same two students with their places swapped.
const MINH_FIRST = {...MINH, rank: 1, stagesPassed: 2, correct: 10, stages: LAN.stages};
const LAN_SECOND = {...LAN, rank: 2, stagesPassed: 1, correct: 7, stages: MINH.stages};

function detail(overrides: Partial<AssignmentDetail> = {}): AssignmentDetail {
  return {
    id: 'a1', code: 'K7M2X9QD4P', jobId: 'job-1', title: 'HSK1 bài 1', label: 'Lớp 6A', timeMode: 'standard', stageLock: 'sequential',
    passPercents: {'1': 70, '2': 70}, maxAttempts: null, showBoard: true, stageCounts: {'1': 5, '2': 5}, createdAt: iso(-60 * MINUTE), closesAt: null, closedAt: null, open: true,
    playerCount: 3, csv: '', players: [LAN, MINH, HOA], ...overrides,
  };
}

// The members of the component these specs call directly instead of through a popconfirm or a dialog.
interface Api {
  closeAssignment(): void;
  openDeadline(mode: 'reopen' | 'schedule'): void;
  saveDeadline(): void;
  removePlayer(player: LeaderboardEntry): void;
  downloadLeaderboard(): void;
  deadline(): Date | null;
}

describe('AssignmentLeaderboard', () => {
  let http: HttpTestingController;
  let notifications: jasmine.SpyObj<NzNotificationService>;
  let fixture: ComponentFixture<AssignmentLeaderboard>;

  beforeEach(() => {
    fullscreenSpy = undefined;
    notifications = jasmine.createSpyObj('NzNotificationService', ['success', 'warning', 'error']);
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    TestBed.configureTestingModule({
      imports: [AssignmentLeaderboard],
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
  // Every student's row: the ranked list first, then the students with no result.
  const rows = () => Array.from(root().querySelectorAll<HTMLElement>('[data-player-id]'));
  const rowOf = (id: string) => root().querySelector<HTMLElement>(`[data-player-id="${id}"]`)!;
  const ids = () => rows().map(row => row.dataset['playerId']);
  const clean = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, ' ').trim();

  // Opens the page and answers its first request. Must run inside fakeAsync: the page polls with timers.
  function open(first: AssignmentDetail | { status: number; body: string } = detail()): void {
    fixture = TestBed.createComponent(AssignmentLeaderboard);
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

  // Puts the board in full screen, or takes it out, the way the browser tells the page: `fullscreenElement` is
  // the board while it is on.
  let fullscreenSpy: jasmine.Spy | undefined;
  function setFullscreen(on: boolean): void {
    const board = root().querySelector('nz-card.board');
    fullscreenSpy ??= spyOnProperty(document, 'fullscreenElement', 'get');
    fullscreenSpy.and.returnValue(on ? board : null);
    document.dispatchEvent(new Event('fullscreenchange'));
    fixture.detectChanges();
  }

  // The next poll's answer, 5 seconds later.
  function answer(next: AssignmentDetail): void {
    tick(5000);
    http.expectOne(ENDPOINT).flush(next);
    fixture.detectChanges();
  }

  // Lets the page's timers go, which a fakeAsync test must do before it ends. A row that slid to its new
  // place has a timer of its own to clean up after itself.
  function leave(): void {
    fixture.destroy();
    discardPeriodicTasks();
    flush();
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

  describe('the ranked list', () => {
    it('is an ordered list named "Bảng xếp hạng" with a row for each student who has a place, in the server order', fakeAsync(() => {
      open();

      const list = root().querySelector('ol.entries');
      expect(list?.getAttribute('aria-label')).toBe('Bảng xếp hạng');
      expect(Array.from(list!.children).map(row => (row as HTMLElement).dataset['playerId'])).toEqual(['p1', 'p2']);
      expect(Array.from(list!.children).map(row => (row as HTMLElement).dataset['rank'])).toEqual(['1', '2']);
      leave();
    }));

    it('shows a medal, the name, the score, the attempts and the time of the last play in each row', fakeAsync(() => {
      open();

      const lan = clean(rowOf('p1'));
      expect(lan).toContain('🥇');
      expect(lan).toContain('Lan');
      expect(lan).toContain('10/10');
      expect(lan).toContain('5/5 ✓');
      expect(lan).toContain('2 lần');
      expect(lan).toContain('08:05');
      const minh = clean(rowOf('p2'));
      expect(minh).toContain('🥈');
      expect(minh).toContain('Minh');
      expect(minh).toContain('7/10');
      expect(minh).toContain('2/5');
      expect(minh).not.toContain('2/5 ✓');
      leave();
    }));

    it('shows the number in a small circle from the fourth place on, and shares a medal between tied students', fakeAsync(() => {
      const fourth = player({id: 'p4', name: 'Nam', rank: 4, correct: 3, stagesPassed: 1});
      open(detail({players: [LAN, {...MINH, rank: 1}, {...HOA, id: 'p5', name: 'Ngọc', rank: 3, correct: 5}, fourth]}));

      expect(Array.from(root().querySelectorAll('.entries:not(.waiting) .rank')).map(rank => rank.textContent?.trim()))
        .toEqual(['🥇', '🥇', '🥉', '4']);
      expect(Array.from(root().querySelectorAll('.rank')).map(rank => rank.classList.contains('is-number')))
        .toEqual([false, false, false, true]);
      leave();
    }));

    it('draws the avatar of every student next to the name', fakeAsync(() => {
      open();

      expect(rows().length).toBe(3);
      for (const row of rows()) {
        expect(row.querySelector('app-player-avatar')).not.toBeNull();
      }
      const lan = rowOf('p1').querySelector('app-player-avatar')!;
      expect(lan.getAttribute('data-size')).toBe('md');
      expect(lan.textContent).toContain('🐱');
      leave();
    }));

    it('puts the name in a scrolling-when-too-long line, with the whole name as its title', fakeAsync(() => {
      open(detail({players: [player({name: 'Nguyễn Hoàng Bảo Ngọc Lan Phương Thảo Vy'})]}));

      const name = rowOf('p1').querySelector('app-marquee-text');
      expect(name?.getAttribute('title')).toBe('Nguyễn Hoàng Bảo Ngọc Lan Phương Thảo Vy');
      leave();
    }));

    it('shows a pip for every stage the quiz has, with the icon of the game and the best run', fakeAsync(() => {
      open();

      const pips = (id: string) => Array.from(rowOf(id).querySelectorAll<HTMLElement>('.pip'));
      expect(pips('p1').map(pip => clean(pip))).toEqual(['👍 5/5 ✓', '🙆 5/5 ✓']);
      expect(pips('p2').map(pip => clean(pip))).toEqual(['👍 5/5 ✓', '🙆 2/5']);
      leave();
    }));

    it('colours a passed pip as passed and a played one that is not passed as played', fakeAsync(() => {
      open();

      const [one, two] = Array.from(rowOf('p2').querySelectorAll<HTMLElement>('.pip'));
      expect(one.classList).toContain('passed');
      expect(one.classList).not.toContain('played');
      expect(two.classList).toContain('played');
      expect(two.classList).not.toContain('passed');
      leave();
    }));

    it('says each stage in words in the title of its pip', fakeAsync(() => {
      open();

      const titles = (id: string) => Array.from(rowOf(id).querySelectorAll<HTMLElement>('.pip')).map(pip => pip.title);
      expect(titles('p1')).toEqual(['Màn 1 · Đúng hay sai: 5/5 ✓ · 1 lần', 'Màn 2 · Nghiêng đầu: 5/5 ✓ · 1 lần']);
      expect(titles('p2')).toEqual(['Màn 1 · Đúng hay sai: 5/5 ✓ · 1 lần', 'Màn 2 · Nghiêng đầu: 2/5 · 3 lần']);
      leave();
    }));

    it('shows a muted dash for a stage not played yet', fakeAsync(() => {
      open(detail({players: [player({stagesPassed: 1, correct: 5, stages: {'1': LAN.stages['1']}})]}));

      const pips = Array.from(rowOf('p1').querySelectorAll<HTMLElement>('.pip'));
      expect(clean(pips[1])).toBe('🙆 –');
      expect(pips[1].classList).not.toContain('passed');
      expect(pips[1].classList).not.toContain('played');
      expect(pips[1].title).toBe('Màn 2 · Nghiêng đầu: chưa chơi');
      leave();
    }));

    it('names and numbers the pips by position among the stages the assignment has', fakeAsync(() => {
      open(detail({
        stageCounts: {'4': 5, '6': 5},
        players: [player({
          stagesPassed: 1, correct: 9, possible: 10,
          stages: {'4': {correct: 5, total: 5, passed: true, attempts: 1}, '6': {correct: 4, total: 5, passed: false, attempts: 1}},
        })],
      }));

      const pips = Array.from(rowOf('p1').querySelectorAll<HTMLElement>('.pip'));
      expect(pips.map(pip => clean(pip))).toEqual(['🍉 5/5 ✓', '🧩 4/5']);
      expect(pips.map(pip => pip.title)).toEqual(['Màn 1 · Chém hoa quả: 5/5 ✓ · 1 lần', 'Màn 2 · Xếp câu: 4/5 · 1 lần']);
      leave();
    }));

    it('fills the bar of the score by the share of the answers got right', fakeAsync(() => {
      open();

      const fill = (id: string) => rowOf(id).querySelector<HTMLElement>('.fill')!;
      expect(fill('p1').style.width).toBe('100%');
      expect(fill('p2').style.width).toBe('70%');
      leave();
    }));

    it('has a button to remove each student, named after them', fakeAsync(() => {
      open();

      const button = rowOf('p2').querySelector('button.remove');
      expect(button?.getAttribute('aria-label')).toBe('Xóa Minh');
      leave();
    }));
  });

  describe('the podium', () => {
    it('shows the students who have a place on the podium, with their stages and answers', fakeAsync(() => {
      open();

      const steps = Array.from(root().querySelectorAll<HTMLElement>('app-leaderboard-podium .step'));
      expect(steps.map(step => step.dataset['rank'])).toEqual(['1', '2']);
      expect(clean(steps[0])).toContain('Lan');
      expect(clean(steps[0])).toContain('2/2 màn · 10/10 câu');
      expect(clean(steps[1])).toContain('Minh');
      expect(clean(steps[1])).toContain('1/2 màn · 7/10 câu');
      leave();
    }));

    it('is the normal size, and the large one in full screen', fakeAsync(() => {
      open();
      expect(root().querySelector('app-leaderboard-podium')?.classList).not.toContain('is-large');

      setFullscreen(true);

      expect(root().querySelector('app-leaderboard-podium')?.classList).toContain('is-large');
      leave();
    }));

    it('is not shown when nobody has a place yet', fakeAsync(() => {
      open(detail({players: [HOA]}));

      expect(root().querySelector('app-leaderboard-podium')).toBeNull();
      expect(root().querySelector('ol.entries')).toBeNull();
      expect(text()).toContain('Chưa có kết quả (1)');
      leave();
    }));
  });

  describe('the students with no result', () => {
    it('are a section of their own under a divider with their number', fakeAsync(() => {
      open();

      expect(clean(root().querySelector('.divider'))).toBe('Chưa có kết quả (1)');
      const list = root().querySelector('ul.waiting');
      expect(list?.getAttribute('aria-labelledby')).toBe('waiting-title');
      expect(Array.from(list!.children).map(row => (row as HTMLElement).dataset['playerId'])).toEqual(['p3']);
      leave();
    }));

    it('show the avatar, the name, the time they joined and the way to remove them, with no medal or stage', fakeAsync(() => {
      open();

      const hoa = rowOf('p3');
      expect(hoa.querySelector('app-player-avatar')).not.toBeNull();
      expect(clean(hoa)).toContain('Hoa');
      expect(clean(hoa)).toMatch(/Vào lúc 07:30/);
      expect(hoa.querySelector('button.remove')?.getAttribute('aria-label')).toBe('Xóa Hoa');
      expect(hoa.querySelector('.rank, .pip, .score, .move')).toBeNull();
      expect(hoa.dataset['rank']).toBeUndefined();
      leave();
    }));

    it('are not last place: no medal, no rank and no dash for what they have not played', fakeAsync(() => {
      open();

      expect(clean(rowOf('p3'))).not.toContain('–');
      leave();
    }));

    it('have no section when everybody has a place', fakeAsync(() => {
      open(detail({players: [LAN, MINH]}));

      expect(root().querySelector('.divider')).toBeNull();
      expect(root().querySelector('ul.waiting')).toBeNull();
      leave();
    }));
  });

  describe('the board header', () => {
    it('is titled "Bảng xếp hạng" and has the pause button for the scrolling names and "Làm mới"', fakeAsync(() => {
      open();

      const header = root().querySelector('.board .ant-card-head')!;
      expect(clean(header.querySelector('.ant-card-head-title'))).toBe('Bảng xếp hạng');
      expect(header.querySelectorAll('app-marquee-pause-button').length).toBe(1);
      expect(header.querySelector('app-marquee-pause-button button')).not.toBeNull();
      expect(clean(header)).toContain('Làm mới');
      leave();
    }));
  });

  describe('full screen', () => {
    it('shows the quiz title, a way out and the pause button, with no remove button, attempts or time', fakeAsync(() => {
      open();

      setFullscreen(true);

      const board = root().querySelector('nz-card.board')!;
      expect(board.classList).toContain('is-fullscreen');
      expect(clean(board.querySelector('.big-title'))).toBe('HSK1 bài 1');
      expect(clean(board)).toContain('Thoát toàn màn hình');
      expect(clean(board)).not.toContain('Làm mới');
      expect(board.querySelector('app-marquee-pause-button')).not.toBeNull();
      expect(board.querySelectorAll('button.remove').length).toBe(0);
      const row = rowOf('p1');
      expect(getComputedStyle(row.querySelector('.attempts')!).display).toBe('none');
      expect(getComputedStyle(row.querySelector('.played-at')!).display).toBe('none');
      expect(clean(row)).toContain('10/10');
      expect(row.querySelectorAll('.pip').length).toBe(2);
      leave();
    }));

    it('draws larger avatars', fakeAsync(() => {
      open();

      setFullscreen(true);

      expect(rowOf('p1').querySelector('app-player-avatar')?.getAttribute('data-size')).toBe('lg');
      expect(rowOf('p3').querySelector('app-player-avatar')?.getAttribute('data-size')).toBe('lg');
      leave();
    }));

    it('goes back to the normal board when full screen ends', fakeAsync(() => {
      open();
      setFullscreen(true);

      setFullscreen(false);

      expect(root().querySelector('nz-card.board')?.classList).not.toContain('is-fullscreen');
      expect(clean(root().querySelector('.board .ant-card-head-title'))).toBe('Bảng xếp hạng');
      expect(clean(root().querySelector('.board'))).toContain('Làm mới');
      expect(root().querySelectorAll('button.remove').length).toBe(3);
      leave();
    }));
  });

  describe('the move of a student who changed place', () => {
    it('shows nothing on the first answer', fakeAsync(() => {
      open();

      expect(root().querySelectorAll('.move').length).toBe(0);
      leave();
    }));

    it('shows ▲ and the places gained for the student who overtook, and ▼ for the one overtaken', fakeAsync(() => {
      open();

      answer(detail({players: [MINH_FIRST, LAN_SECOND, HOA]}));

      expect(ids()).toEqual(['p2', 'p1', 'p3']);
      const up = rowOf('p2').querySelector<HTMLElement>('.move')!;
      expect(up.textContent?.trim()).toBe('▲1');
      expect(up.getAttribute('aria-label')).toBe('Lên 1 hạng');
      expect(up.classList).toContain('up');
      const down = rowOf('p1').querySelector<HTMLElement>('.move')!;
      expect(down.textContent?.trim()).toBe('▼1');
      expect(down.getAttribute('aria-label')).toBe('Xuống 1 hạng');
      expect(down.classList).toContain('down');
      expect(rowOf('p3').querySelector('.move')).toBeNull();
      leave();
    }));

    it('keeps the mark while the students stay put and drops it 30 seconds after the change', fakeAsync(() => {
      open();
      answer(detail({players: [MINH_FIRST, LAN_SECOND, HOA]}));

      for (let i = 0; i < 5; i++) {
        answer(detail({players: [MINH_FIRST, LAN_SECOND, HOA]}));
      }
      // 25 seconds after the change.
      expect(rowOf('p2').querySelector('.move')?.textContent?.trim()).toBe('▲1');

      answer(detail({players: [MINH_FIRST, LAN_SECOND, HOA]}));
      // 30 seconds after it.
      expect(root().querySelectorAll('.move').length).toBe(0);
      leave();
    }));

    it('shows no mark for a student who joined or whose place did not change', fakeAsync(() => {
      open(detail({players: [LAN, HOA]}));

      answer(detail({players: [LAN, {...HOA, id: 'p4', name: 'Tú'}, HOA]}));

      expect(root().querySelectorAll('.move').length).toBe(0);
      leave();
    }));

    it('has no mark on a student who had no place and has one now', fakeAsync(() => {
      open(detail({players: [LAN, HOA]}));

      answer(detail({players: [LAN, {...HOA, rank: 2, stagesPassed: 1, correct: 4, stages: MINH.stages}]}));

      expect(rowOf('p3').querySelector('.move')).toBeNull();
      leave();
    }));
  });

  describe('sliding the rows to their new places', () => {
    it('slides the rows that changed place, and cleans up after itself', fakeAsync(() => {
      open();

      answer(detail({players: [MINH_FIRST, LAN_SECOND, HOA]}));

      expect(rowOf('p1').style.transition).toContain('transform');
      expect(rowOf('p2').style.transition).toContain('transform');
      expect(rowOf('p3').style.transition).toBe('');
      tick(500);
      expect(rowOf('p1').style.transition).toBe('');
      expect(rowOf('p1').style.transform).toBe('');
      leave();
    }));

    it('does not slide on the first answer', fakeAsync(() => {
      open();

      for (const row of rows()) {
        expect(row.style.transition).toBe('');
      }
      leave();
    }));

    it('does not slide when the order stays', fakeAsync(() => {
      open();

      answer(detail({players: [{...LAN, correct: 9}, MINH, HOA]}));

      for (const row of rows()) {
        expect(row.style.transition).toBe('');
      }
      leave();
    }));

    it('does not slide for a visitor who prefers reduced motion', fakeAsync(() => {
      // Only this preference is faked: other parts of the page (the library's breakpoints) ask for their own queries.
      const real = window.matchMedia.bind(window);
      spyOn(window, 'matchMedia').and.callFake(query => query === '(prefers-reduced-motion: reduce)'
        ? {matches: true, addEventListener: () => undefined, removeEventListener: () => undefined} as unknown as MediaQueryList
        : real(query));
      open();

      answer(detail({players: [MINH_FIRST, LAN_SECOND, HOA]}));

      expect(ids()).toEqual(['p2', 'p1', 'p3']);
      for (const row of rows()) {
        expect(row.style.transition).toBe('');
      }
      leave();
    }));
  });

  it('says in the header the percentage that passes a stage, once when every stage shares it', fakeAsync(() => {
    open();

    expect(text()).toContain('Điểm qua màn: 70%');
    leave();
  }));

  it('lists the percentage of each stage by position when they differ', fakeAsync(() => {
    open(detail({
      stageCounts: {'4': 5, '6': 5},
      passPercents: {'4': 70, '6': 50},
      players: [player({
        stagesPassed: 1, correct: 9, possible: 10,
        stages: {'4': {correct: 5, total: 5, passed: true, attempts: 1}, '6': {correct: 4, total: 5, passed: true, attempts: 1}},
      })],
    }));

    expect(text()).toContain('Điểm qua màn: Màn 1 70% · Màn 2 50%');
    leave();
  }));

  it('says in the header how many runs of a stage a student may play when the teacher limited them', fakeAsync(() => {
    open(detail({stageLock: 'open', maxAttempts: 3}));

    expect(text()).toContain('Giới hạn: 3 lần/màn');
    leave();
  }));

  it('says nothing about a limit when the runs are not limited', fakeAsync(() => {
    open();

    expect(text()).not.toContain('Giới hạn');
    leave();
  }));

  it('says in the header that the students do not see the board when the teacher hid it', fakeAsync(() => {
    open(detail({showBoard: false}));

    expect(text()).toContain('Học sinh không xem bảng xếp hạng');
    leave();
  }));

  it('says nothing about the students board when they see it', fakeAsync(() => {
    open();

    expect(text()).not.toContain('Học sinh không xem bảng xếp hạng');
    leave();
  }));

  it('invites the teacher to share the link when nobody has joined, and shows it while the assignment is open', fakeAsync(() => {
    open(detail({players: []}));

    expect(text()).toContain('Chưa có học sinh nào vào bài. Gửi link hoặc cho học sinh quét mã QR nhé.');
    expect(root().querySelector('app-share-link')).not.toBeNull();
    expect(root().querySelector('app-leaderboard-podium')).toBeNull();
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
    expect(rows().length).toBe(0);
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

    it('keeps the last leaderboard quietly when a refresh fails', fakeAsync(() => {
      open();

      tick(5000);
      http.expectOne(ENDPOINT).flush('boom', {status: 500, statusText: 'Server Error'});
      fixture.detectChanges();
      expect(rows().length).toBe(3);
      expect(notifications.error).not.toHaveBeenCalled();

      tick(5000);
      http.expectOne(ENDPOINT).flush(detail());
      fixture.detectChanges();
      expect(rows().length).toBe(3);
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

    it('removes a student and then asks for the leaderboard again', fakeAsync(() => {
      open();

      api().removePlayer(HOA);
      const removal = http.expectOne(`${ENDPOINT}/players/p3`);
      expect(removal.request.method).toBe('DELETE');
      removal.flush(null, {status: 204, statusText: 'No Content'});
      http.expectOne(ENDPOINT).flush(detail({players: [LAN, MINH]}));
      fixture.detectChanges();

      expect(rows().length).toBe(2);
      expect(text()).not.toContain('Hoa');
      expect(root().querySelector('.divider')).toBeNull();
      leave();
    }));
  });

  describe('downloading the leaderboard', () => {
    it('saves a CSV named after the quiz and the label', fakeAsync(() => {
      open();
      let blob: Blob | undefined;
      spyOn(URL, 'createObjectURL').and.callFake((object: Blob | MediaSource) => {
        blob = object as Blob;
        return 'blob:leaderboard';
      });
      spyOn(URL, 'revokeObjectURL');
      let fileName = '';
      spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) {
        fileName = this.download;
      });

      api().downloadLeaderboard();

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
