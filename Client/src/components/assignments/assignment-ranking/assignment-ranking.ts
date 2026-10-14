import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzCardComponent } from 'ng-zorro-antd/card';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzPopconfirmDirective } from 'ng-zorro-antd/popconfirm';
import { NzSpinComponent } from 'ng-zorro-antd/spin';
import { NzTableModule } from 'ng-zorro-antd/table';
import { NzTagComponent } from 'ng-zorro-antd/tag';
import {
  catchError,
  distinctUntilChanged,
  exhaustMap,
  filter,
  finalize,
  map,
  Observable,
  of,
  switchMap,
  tap,
  timer,
} from 'rxjs';
import { STAGES, stagePosition } from '../../../game/stages';
import {
  Assignment,
  assignmentErrorMessage,
  AssignmentChange,
  AssignmentDetail,
  assignmentStatusText,
  formatStamp,
  isOpenAt,
  RankedPlayer,
  rankingCsv,
  shareUrl,
  STAGE_LOCK_LABELS,
  TIME_MODE_LABELS,
} from '../../../models/assignment';
import { AssignmentService } from '../../../services/assignment.service';
import { DeadlinePicker } from '../deadline-picker/deadline-picker';
import { ShareLink } from '../share-link/share-link';
import { fileNameFor, medal, shouldPoll, stageCell } from './assignment-ranking-logic';

// While the assignment is open (or just closed) the ranking is asked for again this often.
const POLL_INTERVAL_MS = 5000;
// "Now" moves on by itself at this pace, so a closing time that passes is noticed between two answers.
const CLOCK_INTERVAL_MS = 30000;

// One stage column of the ranking: the stage's number (the key of the results, which identifies its game),
// the position shown in its header (among the assignment's stages), and the name and icon of the game.
interface StageColumn {
  key: string;
  position: number;
  icon: string;
  name: string;
}

// One assignment's ranking page (/assignments/:id): the link and the actions of the teacher, and the
// students ranked by what they have passed. The server ranks them; this page shows the ranking as it is
// and keeps it fresh while results can still arrive.
@Component({
  selector: 'app-assignment-ranking',
  imports: [
    DatePipe,
    RouterLink,
    NzButtonComponent,
    NzCardComponent,
    NzIconDirective,
    NzModalModule,
    NzPopconfirmDirective,
    NzSpinComponent,
    NzTableModule,
    NzTagComponent,
    DeadlinePicker,
    ShareLink,
  ],
  templateUrl: './assignment-ranking.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './assignment-ranking.css',
})
export class AssignmentRanking {
  protected readonly medal = medal;
  protected readonly stageCell = stageCell;
  protected readonly formatStamp = formatStamp;
  protected readonly timeModeLabels = TIME_MODE_LABELS;
  protected readonly stageLockLabels = STAGE_LOCK_LABELS;

  protected readonly detail = signal<AssignmentDetail | null>(null);
  protected readonly notFound = signal(false);
  // Why the first load failed, while there is nothing to show yet. Later failures keep the last data.
  protected readonly loadError = signal<string | null>(null);
  // The last poll failed: the ranking shown may be out of date.
  protected readonly stale = signal(false);
  // A refresh the teacher asked for is under way.
  protected readonly refreshing = signal(false);
  // A change to the assignment (close, reopen, closing time) is being saved.
  protected readonly busy = signal(false);
  protected readonly fullscreen = signal(false);
  protected readonly qrOpen = signal(false);
  protected readonly deadlineOpen = signal(false);
  // Kept apart from `deadlineOpen` so the dialog keeps its wording while it fades out.
  protected readonly deadlineMode = signal<'reopen' | 'schedule'>('schedule');
  protected readonly deadline = signal<Date | null>(null);
  // Refreshed by every answer and every 30 s, so what depends on the time (open or closed, whether to
  // poll) follows it without a timer of its own.
  protected readonly now = signal(new Date());

  protected readonly players = computed(() => this.detail()?.players ?? []);
  protected readonly open = computed(() => {
    const detail = this.detail();
    return detail !== null && isOpenAt(detail, this.now());
  });
  protected readonly statusText = computed(() => {
    const detail = this.detail();
    return detail === null ? '' : assignmentStatusText(detail, this.now());
  });
  // The ranking is changing by itself (open, or inside the grace period after it closed).
  protected readonly live = computed(() => {
    const detail = this.detail();
    return detail !== null && shouldPoll(detail, this.now());
  });
  protected readonly stages = computed<StageColumn[]>(() => {
    const keys = Object.keys(this.detail()?.stageCounts ?? {}).sort((a, b) => Number(a) - Number(b));
    return keys.map(key => {
      const def = STAGES.find(stage => stage.stage === Number(key));
      return {
        key,
        position: stagePosition(keys.map(Number), Number(key)),
        icon: def?.icon ?? '',
        name: def?.name ?? '',
      };
    });
  });
  // A closing time in the past would close the assignment at once, and the server refuses it.
  protected readonly deadlineInPast = computed(() => {
    const deadline = this.deadline();
    return deadline !== null && deadline.getTime() <= this.now().getTime();
  });

  private readonly route = inject(ActivatedRoute);
  private readonly assignments = inject(AssignmentService);
  private readonly notificationService = inject(NzNotificationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly board = viewChild('board', {read: ElementRef<HTMLElement>});

  private id = '';
  // Every request gets a number, and an answer is used only if it is newer than what is already shown:
  // a poll that left before a student was removed or the assignment closed must not undo it on arrival.
  private requestSeq = 0;
  private latestApplied = 0;

  constructor() {
    this.route.paramMap.pipe(
      map(params => params.get('id') ?? ''),
      distinctUntilChanged(),
      tap(id => this.start(id)),
      // The first answer is always asked for; after it, only while the ranking can still change and the
      // tab is on screen. A tick that finds the previous request still running is dropped.
      switchMap(id => timer(0, POLL_INTERVAL_MS).pipe(
        filter(tick => tick === 0 || this.wantsPoll()),
        exhaustMap(() => this.load(id)),
      )),
      takeUntilDestroyed(),
    ).subscribe();

    timer(CLOCK_INTERVAL_MS, CLOCK_INTERVAL_MS).pipe(takeUntilDestroyed())
      .subscribe(() => this.now.set(new Date()));
  }

  // A tab that was in the background missed the polls: catch up as soon as it is looked at again.
  @HostListener('document:visibilitychange')
  protected onVisibilityChange(): void {
    if (this.wantsPoll()) {
      this.load(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
    }
  }

  @HostListener('document:fullscreenchange')
  protected onFullscreenChange(): void {
    const element = document.fullscreenElement;
    this.fullscreen.set(element !== null && element === this.board()?.nativeElement);
  }

  protected refresh(): void {
    this.refreshing.set(true);
    this.load(this.id).pipe(
      finalize(() => this.refreshing.set(false)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }

  protected async copyLink(): Promise<void> {
    const detail = this.detail();
    if (detail === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl(detail.code));
      this.notificationService.success('Đã sao chép link', 'Gửi link này cho học sinh nhaa.', {nzPlacement: 'top'});
    } catch {
      // No clipboard access (an insecure page, or the browser said no): the QR dialog shows a field to copy by hand.
      this.notificationService.warning('Chưa sao chép được',
        'Bạn mở Mã QR, link nằm ở đó để sao chép bằng Ctrl+C nhé.', {nzPlacement: 'top'});
    }
  }

  protected closeAssignment(): void {
    this.change({closed: true}).subscribe({
      next: () => this.notificationService.success('Đã đóng bài',
        'Học sinh không vào chơi được nữa. Kết quả đang chơi dở vẫn được nhận thêm vài phút.', {nzPlacement: 'top'}),
      error: err => this.fail('Không đóng được bài', err),
    });
  }

  // Reopening starts with no closing time (the old one has most likely passed); scheduling starts from the
  // closing time the assignment has.
  protected openDeadline(mode: 'reopen' | 'schedule'): void {
    const closesAt = this.detail()?.closesAt ?? null;
    this.deadlineMode.set(mode);
    this.deadline.set(mode === 'schedule' && closesAt !== null ? new Date(closesAt) : null);
    this.deadlineOpen.set(true);
  }

  protected saveDeadline(): void {
    const deadline = this.deadline();
    const closesAt = deadline === null ? null : deadline.toISOString();
    const reopen = this.deadlineMode() === 'reopen';
    // A reopen always names its closing time: the one kept from before may be in the past, which the server refuses.
    this.change(reopen ? {closed: false, closesAt} : {closesAt}).subscribe({
      next: () => {
        this.deadlineOpen.set(false);
        this.notificationService.success(
          reopen ? 'Đã mở lại bài' : closesAt === null ? 'Đã bỏ giờ đóng' : 'Đã hẹn giờ đóng',
          reopen ? 'Học sinh vào chơi lại được bằng link cũ.' : 'Bài sẽ đóng đúng giờ đã chọn.',
          {nzPlacement: 'top'});
      },
      error: err => this.fail(reopen ? 'Không mở lại được bài' : 'Không hẹn giờ được', err),
    });
  }

  protected downloadRanking(): void {
    const detail = this.detail();
    if (detail === null) {
      return;
    }
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([rankingCsv(detail)], {type: 'text/csv;charset=utf-8'}));
    link.href = url;
    link.download = fileNameFor(detail);
    link.click();
    URL.revokeObjectURL(url);
  }

  protected toggleFullscreen(): void {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
      return;
    }
    const failed = () => this.notificationService.warning(
      'Không bật được toàn màn hình',
      'Trình duyệt không cho phép chế độ toàn màn hình ở đây.',
      {nzPlacement: 'top'});
    try {
      this.board()?.nativeElement.requestFullscreen().catch(failed);
    } catch {
      failed();
    }
  }

  protected removePlayer(player: RankedPlayer): void {
    const id = this.id;
    this.assignments.removePlayer(id, player.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      // The ranks of the others may move up, so the ranking is asked for again rather than patched.
      next: () => this.load(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(),
      error: err => this.fail('Không xóa được học sinh', err),
    });
  }

  // A new route id starts a new page: nothing of the previous assignment stays on screen.
  private start(id: string): void {
    this.id = id;
    this.latestApplied = this.requestSeq;
    this.detail.set(null);
    this.notFound.set(false);
    this.loadError.set(null);
    this.stale.set(false);
  }

  private wantsPoll(): boolean {
    if (document.visibilityState !== 'visible' || this.notFound()) {
      return false;
    }
    const detail = this.detail();
    return detail === null || shouldPoll(detail, new Date());
  }

  // Asks for the assignment and shows the answer. It never fails: a failure is shown as a state of the
  // page, so a poll that errors does not end the stream of polls.
  private load(id: string): Observable<void> {
    const seq = ++this.requestSeq;
    return this.assignments.get(id).pipe(
      map(detail => this.received(id, seq, detail)),
      catchError(err => of(this.failedToLoad(id, seq, err))),
    );
  }

  private received(id: string, seq: number, detail: AssignmentDetail): void {
    if (id !== this.id || seq <= this.latestApplied) {
      return;
    }
    this.latestApplied = seq;
    this.detail.set(detail);
    this.loadError.set(null);
    this.stale.set(false);
    this.now.set(new Date());
  }

  private failedToLoad(id: string, seq: number, err: unknown): void {
    if (id !== this.id || seq <= this.latestApplied) {
      return;
    }
    if (err instanceof HttpErrorResponse && err.status === 404) {
      this.notFound.set(true);
    } else if (this.detail() === null) {
      this.loadError.set(assignmentErrorMessage(err));
    } else {
      this.stale.set(true);
    }
  }

  // Saves a change and merges the assignment the server answers with into the page, keeping the students.
  private change(change: AssignmentChange): Observable<Assignment> {
    const id = this.id;
    this.busy.set(true);
    return this.assignments.update(id, change).pipe(
      tap(assignment => {
        if (id === this.id) {
          this.detail.update(detail => detail && {...detail, ...assignment});
          // Answers to requests sent before this change describe the assignment as it was.
          this.latestApplied = this.requestSeq;
          this.now.set(new Date());
        }
      }),
      finalize(() => this.busy.set(false)),
      takeUntilDestroyed(this.destroyRef),
    );
  }

  private fail(title: string, err: unknown): void {
    if (err instanceof HttpErrorResponse && err.status === 404) {
      this.notFound.set(true);
    }
    this.notificationService.error(title, assignmentErrorMessage(err), {nzPlacement: 'top'});
  }
}
