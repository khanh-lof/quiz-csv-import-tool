import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  HostListener,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { StudentBoard, StudentBoardEntry } from '../../../models/assignment';
import { SharedPlayService } from '../../../services/shared-play.service';
import { MarqueePauseButton } from '../../leaderboard/marquee-pause-button/marquee-pause-button';
import { MarqueeText } from '../../leaderboard/marquee-text/marquee-text';
import { PlayerAvatar } from '../../leaderboard/player-avatar/player-avatar';

// How often a visible board asks again, in ms.
export const BOARD_POLL_MS = 30000;

const MEDALS: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

// One line of the board: a student's entry, flagged when it is the viewer's own, and whether a "⋯" goes before
// it (the viewer's own row when it is not among the top).
interface BoardRow {
  entry: StudentBoardEntry;
  you: boolean;
  gapBefore: boolean;
}

// The board a student sees of an assignment: the top five (more when they tie) and their own row, which is
// marked "Bạn" and, when it is outside the top, comes after a "⋯". It fetches the board itself: on init,
// when `code` or `refreshKey` changes (the page bumps it after each result it has saved), every 30 s while
// the tab is visible and once when the tab comes back. A failed load keeps the last board quietly, an
// answer older than the one on screen is dropped, and nothing shows before the first answer. It is also the
// final board on the closed card, since the route answers after the close.
@Component({
  selector: 'app-student-leaderboard',
  imports: [MarqueePauseButton, MarqueeText, PlayerAvatar],
  templateUrl: './student-leaderboard.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './student-leaderboard.css',
})
export class StudentLeaderboard {
  readonly code = input.required<string>();
  // Changes (the page counts up) whenever the board is known to have changed and should be read again.
  readonly refreshKey = input(0);

  private readonly sharedPlay = inject(SharedPlayService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly board = signal<StudentBoard | null>(null);

  protected readonly rows = computed<BoardRow[]>(() => {
    const board = this.board();
    if (!board) {
      return [];
    }
    const rows: BoardRow[] = board.top.map(entry => ({ entry, you: entry.you === true, gapBefore: false }));
    const own = board.you;
    if (own && own.rank !== null && !rows.some(row => row.you)) {
      rows.push({ entry: own, you: true, gapBefore: true });
    }
    return rows;
  });
  // The viewer has joined but has no result yet, so they are not on the board.
  protected readonly unranked = computed(() => {
    const own = this.board()?.you;
    return !!own && own.rank === null;
  });

  // Requests are numbered so that a slow answer for an older one never replaces a newer board.
  private sent = 0;
  private applied = 0;
  private loadedCode: string | null = null;

  constructor() {
    effect(() => {
      const code = this.code();
      this.refreshKey();
      untracked(() => {
        if (code !== this.loadedCode) {
          // Another assignment's board must not stay on screen while this one loads.
          this.loadedCode = code;
          this.board.set(null);
        }
        this.load();
      });
    });
    const timer = setInterval(() => this.loadIfVisible(), BOARD_POLL_MS);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  @HostListener('document:visibilitychange')
  protected onVisibilityChange(): void {
    this.loadIfVisible();
  }

  protected badge(rank: number | null): string {
    return rank === null ? '' : (MEDALS[rank] ?? String(rank));
  }

  protected isMedal(rank: number | null): boolean {
    return rank !== null && rank in MEDALS;
  }

  private loadIfVisible(): void {
    if (document.visibilityState === 'visible') {
      this.load();
    }
  }

  private load(): void {
    const mine = ++this.sent;
    this.sharedPlay.leaderboard(this.code()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: board => {
        if (mine > this.applied) {
          this.applied = mine;
          this.board.set(board);
        }
      },
      // The board is a nicety next to the game: a miss leaves the last one on screen and says nothing.
      error: () => undefined,
    });
  }
}
