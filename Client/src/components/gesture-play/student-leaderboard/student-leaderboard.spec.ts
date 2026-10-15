import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, discardPeriodicTasks, fakeAsync, TestBed, tick } from '@angular/core/testing';
import { Observable, of, Subject, throwError } from 'rxjs';
import { StudentBoard, StudentBoardEntry } from '../../../models/assignment';
import { SharedPlayService } from '../../../services/shared-play.service';
import { BOARD_POLL_MS, StudentLeaderboard } from './student-leaderboard';

const CODE = 'ABC123DEF4';
const PAUSE_KEY = 'leaderboard-marquee-paused';

function entry(rank: number | null, name: string, overrides: Partial<StudentBoardEntry> = {}): StudentBoardEntry {
  return { rank, name, avatar: 'cat', stagesPassed: 2, correct: 8, you: false, ...overrides };
}

const TOP = [entry(1, 'Lan'), entry(2, 'Minh'), entry(3, 'Hoa'), entry(4, 'Nam'), entry(5, 'Vy')];

function board(overrides: Partial<StudentBoard> = {}): StudentBoard {
  return { top: TOP, you: null, possible: 30, stageCount: 6, playerCount: 12, ...overrides };
}

const httpError = (status: number, body?: string) =>
  throwError(() => new HttpErrorResponse({ status, error: body ?? null }));

describe('StudentLeaderboard', () => {
  let fixture: ComponentFixture<StudentLeaderboard>;
  let shared: jasmine.SpyObj<SharedPlayService>;
  let visibility: jasmine.Spy;

  beforeEach(() => {
    localStorage.removeItem(PAUSE_KEY);
    visibility = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    shared = jasmine.createSpyObj<SharedPlayService>('SharedPlayService', ['leaderboard']);
    shared.leaderboard.and.callFake(() => of(board()));
    TestBed.configureTestingModule({
      imports: [StudentLeaderboard],
      providers: [{ provide: SharedPlayService, useValue: shared }],
    });
  });

  afterEach(() => localStorage.removeItem(PAUSE_KEY));

  const root = () => fixture.nativeElement as HTMLElement;
  const rows = () => Array.from(root().querySelectorAll<HTMLElement>('li.row'));
  const clean = (element: Element | null | undefined) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const ranks = () => rows().map(row => clean(row.querySelector('.rank')));
  const names = () => rows().map(row => clean(row.querySelector('app-marquee-text')));

  function open(): void {
    fixture = TestBed.createComponent(StudentLeaderboard);
    fixture.componentRef.setInput('code', CODE);
    fixture.detectChanges();
  }

  // A fakeAsync test must let the poll's timer go before it ends.
  function leave(): void {
    fixture.destroy();
    discardPeriodicTasks();
  }

  it('shows nothing, not even a spinner, before the first answer', fakeAsync(() => {
    const answer = new Subject<StudentBoard>();
    shared.leaderboard.and.returnValue(answer);
    open();

    expect(shared.leaderboard).toHaveBeenCalledOnceWith(CODE);
    expect(clean(root())).toBe('');
    expect(root().querySelector('nz-spin')).toBeNull();

    answer.next(board());
    fixture.detectChanges();

    expect(rows().length).toBe(5);
    leave();
  }));

  it('is a card titled "Bảng xếp hạng" with the pause switch for the moving names', fakeAsync(() => {
    open();

    expect(clean(root().querySelector('h2'))).toBe('🏆 Bảng xếp hạng');
    expect(root().querySelector('section')?.getAttribute('aria-labelledby')).toBe(root().querySelector('h2')?.id);
    const pause = root().querySelector('app-marquee-pause-button button')!;
    expect(pause.getAttribute('aria-label')).toBe('Dừng chữ chạy');
    leave();
  }));

  it('lists the top rows in order with a medal for the first three, then the number', fakeAsync(() => {
    open();

    expect(names()).toEqual(['Lan', 'Minh', 'Hoa', 'Nam', 'Vy']);
    expect(ranks()).toEqual(['🥇', '🥈', '🥉', '4', '5']);
    expect(rows()[0].querySelector('.rank')?.getAttribute('aria-label')).toBe('Hạng 1');
    expect(rows()[3].querySelector('.rank')?.getAttribute('aria-label')).toBeNull();
    leave();
  }));

  it('shows a player\'s avatar, and the stages and answers out of what is possible', fakeAsync(() => {
    shared.leaderboard.and.returnValue(of(board({
      top: [entry(1, 'Lan', { avatar: 'dragon', stagesPassed: 4, correct: 21 })], stageCount: 5, possible: 25,
    })));
    open();

    expect(rows()[0].querySelector('app-player-avatar')?.textContent?.trim()).toBe('🐲');
    expect(clean(rows()[0].querySelector('.score'))).toBe('4/5 màn · 21/25 câu');
    leave();
  }));

  it('gives a tie the same medal', fakeAsync(() => {
    shared.leaderboard.and.returnValue(of(board({
      top: [entry(1, 'Lan'), entry(1, 'Minh'), entry(3, 'Hoa')],
    })));
    open();

    expect(ranks()).toEqual(['🥇', '🥇', '🥉']);
    leave();
  }));

  describe('the student\'s own row', () => {
    it('is highlighted with a "Bạn" tag when it is in the top', fakeAsync(() => {
      shared.leaderboard.and.returnValue(of(board({
        top: [entry(1, 'Lan'), entry(2, 'Minh', { you: true }), entry(3, 'Hoa')],
        you: entry(2, 'Minh'),
      })));
      open();

      const own = root().querySelectorAll('li.row.is-you');
      expect(own.length).toBe(1);
      expect(clean(own[0].querySelector('app-marquee-text'))).toBe('Minh');
      expect(clean(own[0].querySelector('.you-tag'))).toBe('Bạn');
      expect(root().querySelectorAll('.you-tag').length).toBe(1);
      expect(root().querySelector('.gap')).toBeNull();
      expect(rows().length).toBe(3);
      leave();
    }));

    it('comes after a "⋯" when it is outside the top', fakeAsync(() => {
      shared.leaderboard.and.returnValue(of(board({ you: entry(9, 'Cúc', { stagesPassed: 1, correct: 4 }) })));
      open();

      expect(rows().length).toBe(6);
      const items = Array.from(root().querySelectorAll('ol > li'));
      expect(items.map(item => clean(item).slice(0, 1)).slice(4)).toEqual(['5', '⋯', '9']);
      expect(items[5].getAttribute('aria-hidden')).toBe('true');
      const own = rows()[5];
      expect(own.classList).toContain('is-you');
      expect(clean(own.querySelector('app-marquee-text'))).toBe('Cúc');
      expect(clean(own.querySelector('.you-tag'))).toBe('Bạn');
      expect(clean(own.querySelector('.score'))).toBe('1/6 màn · 4/30 câu');
      expect(rows().slice(0, 5).some(row => row.classList.contains('is-you'))).toBeFalse();
      leave();
    }));

    it('is a muted line when the student has no result yet', fakeAsync(() => {
      shared.leaderboard.and.returnValue(of(board({ you: entry(null, 'Cúc', { stagesPassed: 0, correct: 0 }) })));
      open();

      expect(clean(root())).toContain('Bạn chưa có kết quả, chơi màn đầu tiên nhé!');
      expect(rows().length).toBe(5);
      expect(root().querySelector('.is-you')).toBeNull();
      expect(root().querySelector('.gap')).toBeNull();
      leave();
    }));

    it('says nothing about the student when there is none (not joined)', fakeAsync(() => {
      open();

      expect(clean(root())).not.toContain('Bạn');
      leave();
    }));
  });

  it('says nobody has a result when the top is empty', fakeAsync(() => {
    shared.leaderboard.and.returnValue(of(board({ top: [] })));
    open();

    expect(clean(root())).toContain('Chưa ai có kết quả.');
    expect(root().querySelector('ol')).toBeNull();
    leave();
  }));

  describe('keeping up', () => {
    it('asks again every 30 seconds while the tab is visible', fakeAsync(() => {
      open();
      expect(shared.leaderboard).toHaveBeenCalledTimes(1);

      tick(BOARD_POLL_MS - 1);
      expect(shared.leaderboard).toHaveBeenCalledTimes(1);
      tick(1);
      expect(shared.leaderboard).toHaveBeenCalledTimes(2);
      tick(BOARD_POLL_MS);
      expect(shared.leaderboard).toHaveBeenCalledTimes(3);
      expect(shared.leaderboard).toHaveBeenCalledWith(CODE);
      leave();
    }));

    it('does not ask while the tab is hidden, and asks once when it is shown again', fakeAsync(() => {
      open();
      visibility.and.returnValue('hidden');

      tick(BOARD_POLL_MS * 3);
      expect(shared.leaderboard).toHaveBeenCalledTimes(1);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(shared.leaderboard).toHaveBeenCalledTimes(1);

      visibility.and.returnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(shared.leaderboard).toHaveBeenCalledTimes(2);
      leave();
    }));

    it('stops asking once it is gone', fakeAsync(() => {
      open();
      fixture.destroy();

      tick(BOARD_POLL_MS * 2);

      expect(shared.leaderboard).toHaveBeenCalledTimes(1);
    }));

    it('shows the newer board after a poll', fakeAsync(() => {
      open();
      shared.leaderboard.and.returnValue(of(board({ top: [entry(1, 'Vy'), entry(2, 'Lan')] })));

      tick(BOARD_POLL_MS);
      fixture.detectChanges();

      expect(names()).toEqual(['Vy', 'Lan']);
      leave();
    }));

    it('keeps the last board, quietly, when a poll fails', fakeAsync(() => {
      open();
      shared.leaderboard.and.returnValue(httpError(500));

      tick(BOARD_POLL_MS);
      fixture.detectChanges();

      expect(names()).toEqual(['Lan', 'Minh', 'Hoa', 'Nam', 'Vy']);
      shared.leaderboard.and.returnValue(httpError(0));
      tick(BOARD_POLL_MS);
      fixture.detectChanges();
      expect(names().length).toBe(5);
      leave();
    }));

    it('shows nothing when the first load fails, and the board once a later one works', fakeAsync(() => {
      shared.leaderboard.and.returnValue(httpError(404));
      open();
      expect(clean(root())).toBe('');

      shared.leaderboard.and.callFake(() => of(board()));
      tick(BOARD_POLL_MS);
      fixture.detectChanges();

      expect(rows().length).toBe(5);
      leave();
    }));

    it('reads the board again when the refresh key changes, and not otherwise', fakeAsync(() => {
      open();
      expect(shared.leaderboard).toHaveBeenCalledTimes(1);

      fixture.componentRef.setInput('refreshKey', 1);
      fixture.detectChanges();
      expect(shared.leaderboard).toHaveBeenCalledTimes(2);

      fixture.detectChanges();
      expect(shared.leaderboard).toHaveBeenCalledTimes(2);

      fixture.componentRef.setInput('refreshKey', 2);
      fixture.detectChanges();
      expect(shared.leaderboard).toHaveBeenCalledTimes(3);
      leave();
    }));

    it('drops an older answer that arrives after a newer one', fakeAsync(() => {
      const older = new Subject<StudentBoard>();
      const newer = new Subject<StudentBoard>();
      const answers: Observable<StudentBoard>[] = [older, newer];
      shared.leaderboard.and.callFake(() => answers.shift()!);
      open();
      fixture.componentRef.setInput('refreshKey', 1);
      fixture.detectChanges();
      expect(shared.leaderboard).toHaveBeenCalledTimes(2);

      newer.next(board({ top: [entry(1, 'Newer')] }));
      older.next(board({ top: [entry(1, 'Older')] }));
      fixture.detectChanges();

      expect(names()).toEqual(['Newer']);
      leave();
    }));

    it('takes an older answer while no newer one has come', fakeAsync(() => {
      const older = new Subject<StudentBoard>();
      const newer = new Subject<StudentBoard>();
      const answers: Observable<StudentBoard>[] = [older, newer];
      shared.leaderboard.and.callFake(() => answers.shift()!);
      open();
      fixture.componentRef.setInput('refreshKey', 1);
      fixture.detectChanges();

      older.next(board({ top: [entry(1, 'Older')] }));
      fixture.detectChanges();

      expect(names()).toEqual(['Older']);
      leave();
    }));

    it('clears the board and reads the new code when the code changes', fakeAsync(() => {
      open();
      const answer = new Subject<StudentBoard>();
      shared.leaderboard.and.returnValue(answer);

      fixture.componentRef.setInput('code', 'ZZZ999ZZZ9');
      fixture.detectChanges();

      expect(shared.leaderboard).toHaveBeenCalledWith('ZZZ999ZZZ9');
      expect(clean(root())).toBe('');

      answer.next(board({ top: [entry(1, 'Other class')] }));
      fixture.detectChanges();
      expect(names()).toEqual(['Other class']);
      leave();
    }));
  });

  describe('when the teacher hid the board', () => {
    it('draws nothing and never asks again after a 404 "Board hidden" on the first load', fakeAsync(() => {
      shared.leaderboard.and.returnValue(httpError(404, 'Board hidden'));
      open();
      expect(shared.leaderboard).toHaveBeenCalledTimes(1);
      expect(clean(root())).toBe('');

      tick(BOARD_POLL_MS * 2);
      document.dispatchEvent(new Event('visibilitychange'));
      fixture.componentRef.setInput('refreshKey', 1);
      fixture.detectChanges();
      fixture.componentRef.setInput('refreshKey', 2);
      fixture.detectChanges();

      expect(shared.leaderboard).toHaveBeenCalledTimes(1);
      expect(clean(root())).toBe('');
      leave();
    }));

    it('clears a board that was on screen and stops asking when a later load says so', fakeAsync(() => {
      open();
      expect(rows().length).toBe(5);
      shared.leaderboard.and.returnValue(httpError(404, '  Board hidden '));

      tick(BOARD_POLL_MS);
      fixture.detectChanges();

      expect(shared.leaderboard).toHaveBeenCalledTimes(2);
      expect(clean(root())).toBe('');
      tick(BOARD_POLL_MS);
      fixture.componentRef.setInput('refreshKey', 1);
      fixture.detectChanges();
      expect(shared.leaderboard).toHaveBeenCalledTimes(2);
      leave();
    }));

    it('ignores an older answer that arrives after the board was found hidden', fakeAsync(() => {
      const older = new Subject<StudentBoard>();
      const newer = new Subject<StudentBoard>();
      const answers: Observable<StudentBoard>[] = [older, newer];
      shared.leaderboard.and.callFake(() => answers.shift()!);
      open();
      fixture.componentRef.setInput('refreshKey', 1);
      fixture.detectChanges();

      newer.error(new HttpErrorResponse({ status: 404, error: 'Board hidden' }));
      older.next(board());
      fixture.detectChanges();

      expect(clean(root())).toBe('');
      leave();
    }));

    it('loads again for a different code', fakeAsync(() => {
      shared.leaderboard.and.returnValue(httpError(404, 'Board hidden'));
      open();
      tick(BOARD_POLL_MS);
      expect(shared.leaderboard).toHaveBeenCalledTimes(1);

      shared.leaderboard.and.callFake(() => of(board({ top: [entry(1, 'Other class')] })));
      fixture.componentRef.setInput('code', 'ZZZ999ZZZ9');
      fixture.detectChanges();

      expect(shared.leaderboard).toHaveBeenCalledTimes(2);
      expect(shared.leaderboard).toHaveBeenCalledWith('ZZZ999ZZZ9');
      expect(names()).toEqual(['Other class']);
      tick(BOARD_POLL_MS);
      expect(shared.leaderboard).toHaveBeenCalledTimes(3);
      leave();
    }));

    it('keeps asking after a 404 with another body (no such assignment)', fakeAsync(() => {
      shared.leaderboard.and.returnValue(httpError(404, 'Assignment not found'));
      open();
      expect(clean(root())).toBe('');

      shared.leaderboard.and.callFake(() => of(board()));
      tick(BOARD_POLL_MS);
      fixture.detectChanges();

      expect(shared.leaderboard).toHaveBeenCalledTimes(2);
      expect(rows().length).toBe(5);
      leave();
    }));

    it('keeps the last board and keeps asking after a server error, whatever its body', fakeAsync(() => {
      open();
      shared.leaderboard.and.returnValue(httpError(500, 'Board hidden'));

      tick(BOARD_POLL_MS);
      fixture.detectChanges();
      expect(names().length).toBe(5);

      shared.leaderboard.and.callFake(() => of(board({ top: [entry(1, 'Vy')] })));
      tick(BOARD_POLL_MS);
      fixture.detectChanges();

      expect(shared.leaderboard).toHaveBeenCalledTimes(3);
      expect(names()).toEqual(['Vy']);
      leave();
    }));
  });
});
