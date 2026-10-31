import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, discardPeriodicTasks, fakeAsync, TestBed, tick } from '@angular/core/testing';
import { Observable, of, Subject, throwError } from 'rxjs';
import { StudentBoard, StudentBoardEntry } from '../../../models/assignment';
import { GameAudio } from '../../../game/game-audio';
import { SharedPlayService } from '../../../services/shared-play.service';
import { BOARD_POLL_MS, StudentLeaderboard } from './student-leaderboard';

const CODE = 'ABC123DEF4';
const PAUSE_KEY = 'leaderboard-marquee-paused';

function entry(rank: number | null, name: string, overrides: Partial<StudentBoardEntry> = {}): StudentBoardEntry {
  return {
    rank,
    name,
    avatar: 'cat',
    stagesPassed: 2,
    correct: 8,
    you: false, ...overrides
  };
}

const TOP = [entry(1, 'Lan'), entry(2, 'Minh'), entry(3, 'Hoa'), entry(4, 'Nam'), entry(5, 'Vy')];

function board(overrides: Partial<StudentBoard> = {}): StudentBoard {
  return {
    top: TOP,
    you: null,
    possible: 30,
    stageCount: 6,
    playerCount: 12, ...overrides
  };
}

const httpError = (status: number, body?: string) =>
  throwError(() => new HttpErrorResponse({
    status,
    error: body ?? null
  }));

describe('StudentLeaderboard', () => {
  let fixture: ComponentFixture<StudentLeaderboard>;
  let shared: jasmine.SpyObj<SharedPlayService>;
  let visibility: jasmine.Spy;
  let audio: jasmine.SpyObj<GameAudio>;

  beforeEach(() => {
    localStorage.removeItem(PAUSE_KEY);
    visibility = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    shared = jasmine.createSpyObj<SharedPlayService>('SharedPlayService', ['leaderboard']);
    shared.leaderboard.and.callFake(() => of(board()));
    audio = jasmine.createSpyObj<GameAudio>('GameAudio', ['play']);
    TestBed.configureTestingModule({
      imports: [StudentLeaderboard],
      providers: [{
        provide: SharedPlayService,
        useValue: shared
      }, {
        provide: GameAudio,
        useValue: audio
      }],
    });
  });

  afterEach(() => localStorage.removeItem(PAUSE_KEY));

  const root = () => fixture.nativeElement as HTMLElement;
  const steps = () => Array.from(root().querySelectorAll<HTMLElement>('li.step'));
  const clean = (element: Element | null | undefined) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const names = () => steps().map(step => clean(step.querySelector('app-marquee-text')));

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

    expect(steps().length).toBe(3);
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

  it('shows the top three as a podium, and leaves out the rest', fakeAsync(() => {
    open();

    expect(names()).toEqual(['Lan', 'Minh', 'Hoa']);
    expect(root().querySelectorAll('li.row').length).toBe(0);
    leave();
  }));

  it('shows a player\'s avatar, and the stages and answers out of what is possible', fakeAsync(() => {
    shared.leaderboard.and.returnValue(of(board({
      top: [entry(1, 'Lan', {
        avatar: 'dragon',
        stagesPassed: 4,
        correct: 21
      })],
      stageCount: 5,
      possible: 25,
    })));
    open();

    expect(steps()[0].querySelector('app-player-avatar')?.textContent?.trim()).toBe('🐲');
    expect(clean(steps()[0].querySelector('.meta'))).toBe('4/5 màn · 21/25 câu');
    leave();
  }));

  describe('the student\'s own place', () => {
    it('is a cheer, with no extra row, when the student is on the podium', fakeAsync(() => {
      shared.leaderboard.and.returnValue(of(board({
        top: [entry(1, 'Lan'), entry(2, 'Minh', { you: true }), entry(3, 'Hoa')],
        you: entry(2, 'Minh'),
      })));
      open();

      expect(clean(root().querySelector('.cheer'))).toContain('Chúc mừng');
      expect(root().querySelector('.own')).toBeNull();
      leave();
    }));

    it('plays the celebration once on reaching the podium, not on every poll', fakeAsync(() => {
      const podium = board({ you: entry(2, 'Minh') });
      shared.leaderboard.and.callFake(() => of(podium));
      open();
      tick(BOARD_POLL_MS);
      fixture.detectChanges();

      expect(audio.play).toHaveBeenCalledOnceWith('finish');
      leave();
    }));

    it('plays it again after falling off the podium and coming back', fakeAsync(() => {
      shared.leaderboard.and.callFake(() => of(board({ you: entry(2, 'Minh') })));
      open();
      shared.leaderboard.and.callFake(() => of(board({ you: entry(7, 'Minh') })));
      tick(BOARD_POLL_MS);
      fixture.detectChanges();
      shared.leaderboard.and.callFake(() => of(board({ you: entry(3, 'Minh') })));
      tick(BOARD_POLL_MS);
      fixture.detectChanges();

      expect(audio.play).toHaveBeenCalledTimes(2);
      leave();
    }));

    it('is a highlighted row under the podium, with no sound, when outside it', fakeAsync(() => {
      shared.leaderboard.and.returnValue(of(board({
        you: entry(9, 'Cúc', {
          stagesPassed: 1,
          correct: 4
        })
      })));
      open();

      const own = root().querySelector('.own')!;
      expect(clean(own.querySelector('app-marquee-text'))).toBe('Cúc');
      expect(clean(own.querySelector('.you-tag'))).toBe('Bạn');
      expect(clean(own.querySelector('.score'))).toBe('Hạng 9 · 1/6 màn · 4/30 câu');
      expect(steps().length).toBe(3);
      expect(root().querySelector('.cheer')).toBeNull();
      expect(audio.play).not.toHaveBeenCalled();
      leave();
    }));

    it('is a muted line when the student has no result yet', fakeAsync(() => {
      shared.leaderboard.and.returnValue(of(board({
        you: entry(null, 'Cúc', {
          stagesPassed: 0,
          correct: 0
        })
      })));
      open();

      expect(clean(root())).toContain('Bạn chưa có kết quả.');
      expect(root().querySelector('.own')).toBeNull();
      expect(audio.play).not.toHaveBeenCalled();
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
    expect(root().querySelector('li.step')).toBeNull();
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

      expect(names()).toEqual(['Lan', 'Minh', 'Hoa']);
      shared.leaderboard.and.returnValue(httpError(0));
      tick(BOARD_POLL_MS);
      fixture.detectChanges();
      expect(names().length).toBe(3);
      leave();
    }));

    it('shows nothing when the first load fails, and the board once a later one works', fakeAsync(() => {
      shared.leaderboard.and.returnValue(httpError(404));
      open();
      expect(clean(root())).toBe('');

      shared.leaderboard.and.callFake(() => of(board()));
      tick(BOARD_POLL_MS);
      fixture.detectChanges();

      expect(steps().length).toBe(3);
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
      expect(steps().length).toBe(3);
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

      newer.error(new HttpErrorResponse({
        status: 404,
        error: 'Board hidden'
      }));
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
      expect(steps().length).toBe(3);
      leave();
    }));

    it('keeps the last board and keeps asking after a server error, whatever its body', fakeAsync(() => {
      open();
      shared.leaderboard.and.returnValue(httpError(500, 'Board hidden'));

      tick(BOARD_POLL_MS);
      fixture.detectChanges();
      expect(names().length).toBe(3);

      shared.leaderboard.and.callFake(() => of(board({ top: [entry(1, 'Vy')] })));
      tick(BOARD_POLL_MS);
      fixture.detectChanges();

      expect(shared.leaderboard).toHaveBeenCalledTimes(3);
      expect(names()).toEqual(['Vy']);
      leave();
    }));
  });
});
