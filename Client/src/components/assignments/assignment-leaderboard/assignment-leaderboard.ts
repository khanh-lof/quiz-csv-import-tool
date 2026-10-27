import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
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
import { stagePosition, STAGES } from '../../../game/stages';
import {
  Assignment,
  AssignmentChange,
  AssignmentDetail,
  assignmentErrorMessage,
  assignmentStatusText,
  formatStamp,
  isOpenAt,
  leaderboardCsv,
  LeaderboardEntry,
  passPercentOf,
  shareUrl,
  STAGE_LOCK_LABELS,
  TIME_MODE_LABELS,
} from '../../../models/assignment';
import { AssignmentService } from '../../../services/assignment.service';
import { LeaderboardPodium } from '../../leaderboard/leaderboard-podium/leaderboard-podium';
import { PodiumEntry } from '../../leaderboard/leaderboard-podium/podium';
import { MarqueePauseButton } from '../../leaderboard/marquee-pause-button/marquee-pause-button';
import { MarqueeText } from '../../leaderboard/marquee-text/marquee-text';
import { PlayerAvatar } from '../../leaderboard/player-avatar/player-avatar';
import { DeadlinePicker } from '../deadline-picker/deadline-picker';
import { ShareLink } from '../share-link/share-link';
import {
  fileNameFor,
  medal,
  MoveMark,
  moveMark,
  orderChanged,
  RankMove,
  rankMoves,
  scorePercent,
  shouldPoll,
  StagePip,
  stagePip,
} from './assignment-leaderboard-logic';
import { captureRows, playFlip, prefersReducedMotion } from './flip';

// While the assignment is open (or just closed) the leaderboard is asked for again this often.
const POLL_INTERVAL_MS = 5000;
// "Now" moves on by itself at this pace, so a closing time that passes is noticed between two answers.
const CLOCK_INTERVAL_MS = 30000;

// One stage of the assignment: the stage's number (the key of the results, which identifies its game), its
// position among the assignment's stages (what a person reads as "Màn <position>"), and the name and icon of
// the game.
interface StageColumn {
  key: string;
  position: number;
  icon: string;
  name: string;
  // The percentage of right answers that passes the stage.
  percent: number;
}

// One row of the ranked list as the template draws it: the student, a pip for each stage, the change of place
// to show (while it is recent) and how full the score's bar is.
interface RankedRow {
  player: LeaderboardEntry;
  pips: StagePip[];
  move: MoveMark | null;
  percent: number;
}

// One assignment's leaderboard page (/assignments/:id): the link and the actions of the teacher, and the
// students ranked by what they have passed: a podium for the first three, a list of everyone with a place,
// and, apart and not as last place, the students who have not finished a stage yet. The server ranks them;
// this page shows the leaderboard as it is, marks the students whose place changed, slides the rows to their
// new places and keeps it fresh while results can still arrive.
@Component({
  selector: 'app-assignment-leaderboard',
  imports: [
    DatePipe,
    NgTemplateOutlet,
    RouterLink,
    NzButtonComponent,
    NzCardComponent,
    NzIconDirective,
    NzModalModule,
    NzPopconfirmDirective,
    NzSpinComponent,
    NzTagComponent,
    DeadlinePicker,
    LeaderboardPodium,
    MarqueePauseButton,
    MarqueeText,
    PlayerAvatar,
    ShareLink,
  ],
  templateUrl: './assignment-leaderboard.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './assignment-leaderboard.css',
})
export class AssignmentLeaderboard {
  protected readonly medal = medal;
  protected readonly formatStamp = formatStamp;
  protected readonly timeModeLabels = TIME_MODE_LABELS;
  protected readonly stageLockLabels = STAGE_LOCK_LABELS;

  protected readonly detail = signal<AssignmentDetail | null>(null);
  protected readonly notFound = signal(false);
  // Why the first load failed, while there is nothing to show yet. Later failures keep the last data.
  protected readonly loadError = signal<string | null>(null);
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
  // The changes of place of the last 30 s by player id (`rankMoves`); a mark is shown while it is recent.
  protected readonly moves = signal<ReadonlyMap<string, RankMove>>(new Map());
  // Refreshed by every answer and every 30 s, so what depends on the time (open or closed, whether to
  // poll, how old a move is) follows it without a timer of its own.
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
  protected readonly stages = computed<StageColumn[]>(() => {
    const keys = Object.keys(this.detail()?.stageCounts ?? {}).sort((a, b) => Number(a) - Number(b));
    return keys.map(key => {
      const def = STAGES.find(stage => stage.stage === Number(key));
      return {
        key,
        position: stagePosition(keys.map(Number), Number(key)),
        icon: def?.icon ?? '',
        name: def?.name ?? '',
        percent: passPercentOf(this.detail()?.passPercents, Number(key)),
      };
    });
  });
  // The pass percentage as one line: "70%" when every stage shares it, else each stage's, "Màn 1 70% · Màn 2 50%".
  protected readonly passText = computed(() => {
    const columns = this.stages();
    if (columns.length === 0) {
      return '';
    }
    const first = columns[0].percent;
    return columns.every(column => column.percent === first)
      ? `${first}%`
      : columns.map(column => `Màn ${column.position} ${column.percent}%`).join(' · ');
  });
  // How many answers the quiz has: what a student's score is out of, for the podium's lines.
  protected readonly possible = computed(() =>
    Object.values(this.detail()?.stageCounts ?? {}).reduce((sum, count) => sum + count, 0));
  // The students with a place, in the server's order, ready to draw.
  protected readonly ranked = computed<RankedRow[]>(() => {
    const columns = this.stages();
    const now = this.now().getTime();
    const moves = this.moves();
    return this.players().filter(player => player.rank !== null).map(player => ({
      player,
      pips: columns.map(column => stagePip(player, column)),
      move: moveMark(moves.get(player.id), now),
      percent: scorePercent(player),
    }));
  });
  // The same students for the podium, which keeps the first three ranks itself.
  protected readonly podium = computed<PodiumEntry[]>(() => this.ranked().map(({ player }) => ({
    key: player.id,
    rank: player.rank ?? 0,
    name: player.name,
    avatar: player.avatar,
    stagesPassed: player.stagesPassed,
    correct: player.correct,
  })));
  // The students who joined and have no result yet: a section of their own, in the order they joined.
  protected readonly waiting = computed(() => this.players().filter(player => player.rank === null));
  // A closing time in the past would close the assignment at once, and the server refuses it.
  protected readonly deadlineInPast = computed(() => {
    const deadline = this.deadline();
    return deadline !== null && deadline.getTime() <= this.now().getTime();
  });

  private readonly route = inject(ActivatedRoute);
  private readonly assignments = inject(AssignmentService);
  private readonly notificationService = inject(NzNotificationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly board = viewChild('board', { read: ElementRef<HTMLElement> });

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
      // The first answer is always asked for; after it, only while the leaderboard can still change and the
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
      this.notificationService.success('Đã sao chép link', '', { nzPlacement: 'top' });
    } catch {
      // No clipboard access (an insecure page, or the browser said no): the QR dialog shows a field to copy by hand.
      this.notificationService.warning('Chưa sao chép được',
        'Lấy link ở Mã QR.', { nzPlacement: 'top' });
    }
  }

  protected closeAssignment(): void {
    this.change({ closed: true }).subscribe({
      next: () => this.notificationService.success('Đã đóng bài',
        '', { nzPlacement: 'top' }),
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
    this.change(reopen ? {
      closed: false,
      closesAt
    } : { closesAt }).subscribe({
      next: () => {
        this.deadlineOpen.set(false);
        this.notificationService.success(
          reopen ? 'Đã mở lại bài' : closesAt === null ? 'Đã bỏ giờ đóng' : 'Đã hẹn giờ đóng',
          '',
          { nzPlacement: 'top' });
      },
      error: err => this.fail(reopen ? 'Không mở lại được bài' : 'Không hẹn giờ được', err),
    });
  }

  protected downloadLeaderboard(): void {
    const detail = this.detail();
    if (detail === null) {
      return;
    }
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([leaderboardCsv(detail)], { type: 'text/csv;charset=utf-8' }));
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
      '',
      { nzPlacement: 'top' });
    try {
      this.board()?.nativeElement.requestFullscreen().catch(failed);
    } catch {
      failed();
    }
  }

  protected removePlayer(player: LeaderboardEntry): void {
    const id = this.id;
    this.assignments.removePlayer(id, player.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      // The ranks of the others may move up, so the leaderboard is asked for again rather than patched.
      next: () => this.load(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(),
      error: err => this.fail('Không xóa được học sinh', err),
    });
  }

  // A new route id starts a new page: nothing of the previous assignment stays on screen.
  private start(id: string): void {
    this.id = id;
    this.latestApplied = this.requestSeq;
    this.detail.set(null);
    this.moves.set(new Map());
    this.notFound.set(false);
    this.loadError.set(null);
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
    const now = new Date();
    // The first answer of a page has no earlier one to compare with: no moves and no sliding.
    const previous = this.detail()?.players ?? null;
    this.moves.set(rankMoves(previous, detail.players, this.moves(), now.getTime()));
    const slide = this.rememberRows(previous, detail.players);
    this.detail.set(detail);
    slide?.();
    this.loadError.set(null);
    this.now.set(now);
  }

  // When the rows are about to change order, takes where they stand and returns what to call once the new
  // answer is set: it slides every row from its old place to its new one after the page has rendered it. Null
  // when nothing moves, there is no earlier answer, or the visitor prefers reduced motion.
  private rememberRows(previous: LeaderboardEntry[] | null, next: LeaderboardEntry[]): (() => void) | null {
    const container: HTMLElement | undefined = this.board()?.nativeElement;
    if (previous === null || container === undefined || !orderChanged(previous, next) || prefersReducedMotion()) {
      return null;
    }
    const before = captureRows(container);
    return () => {
      afterNextRender(() => playFlip(container, before), { injector: this.injector });
    };
  }

  private failedToLoad(id: string, seq: number, err: unknown): void {
    if (id !== this.id || seq <= this.latestApplied) {
      return;
    }
    if (err instanceof HttpErrorResponse && err.status === 404) {
      this.notFound.set(true);
    } else if (this.detail() === null) {
      this.loadError.set(assignmentErrorMessage(err));
    }
  }

  // Saves a change and merges the assignment the server answers with into the page, keeping the students.
  private change(change: AssignmentChange): Observable<Assignment> {
    const id = this.id;
    this.busy.set(true);
    return this.assignments.update(id, change).pipe(
      tap(assignment => {
        if (id === this.id) {
          this.detail.update(detail => detail && { ...detail, ...assignment });
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
    this.notificationService.error(title, assignmentErrorMessage(err), { nzPlacement: 'top' });
  }
}
