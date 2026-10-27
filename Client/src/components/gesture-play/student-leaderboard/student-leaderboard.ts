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
import { HttpErrorResponse } from '@angular/common/http';
import { StudentBoard, StudentBoardEntry } from '../../../models/assignment';
import { SharedPlayService } from '../../../services/shared-play.service';
import { GameAudio } from '../../../game/game-audio';
import { LeaderboardPodium } from '../../leaderboard/leaderboard-podium/leaderboard-podium';
import { PodiumEntry } from '../../leaderboard/leaderboard-podium/podium';
import { MarqueePauseButton } from '../../leaderboard/marquee-pause-button/marquee-pause-button';
import { MarqueeText } from '../../leaderboard/marquee-text/marquee-text';
import { PlayerAvatar } from '../../leaderboard/player-avatar/player-avatar';

// How often a visible board asks again, in ms.
export const BOARD_POLL_MS = 30000;

// The plain-text body of the 404 the server answers when the teacher hid the board from the students.
const BOARD_HIDDEN = 'Board hidden';

const PODIUM_RANKS = 3;

// The board a student sees of an assignment: the podium of the top three, and the student's own row ("Bạn")
// under it when they are not on the podium. A student who reaches the podium hears a celebration, once each
// time they come onto it. It fetches the board itself: on init,
// when `code` or `refreshKey` changes (the page bumps it after each result it has saved), every 30 s while
// the tab is visible and once when the tab comes back. A failed load keeps the last board quietly, an
// answer older than the one on screen is dropped, and nothing shows before the first answer. It is also the
// final board on the closed card, since the route answers after the close. A 404 `Board hidden` means the
// teacher keeps the board to themselves: the component then draws nothing and stops asking until `code`
// changes (the page does not mount it at all when it already knows, so this only covers a link that was
// closed when opened).
@Component({
  selector: 'app-student-leaderboard',
  imports: [LeaderboardPodium, MarqueePauseButton, MarqueeText, PlayerAvatar],
  templateUrl: './student-leaderboard.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './student-leaderboard.css',
})
export class StudentLeaderboard {
  readonly code = input.required<string>();
  // Changes (the page counts up) whenever the board is known to have changed and should be read again.
  readonly refreshKey = input(0);
  protected readonly board = signal<StudentBoard | null>(null);
  protected readonly podium = computed<PodiumEntry[]>(() => (this.board()?.top ?? [])
    .filter(entry => entry.rank !== null && entry.rank <= PODIUM_RANKS)
    .map(entry => ({
      key: entry.name,
      rank: entry.rank!,
      name: entry.name,
      avatar: entry.avatar,
      stagesPassed: entry.stagesPassed,
      correct: entry.correct
    })));
  // The viewer's own line, when they have a result but are not on the podium.
  protected readonly ownRow = computed(() => {
    const own = this.board()?.you;
    return own && own.rank !== null && own.rank > PODIUM_RANKS ? own : null;
  });
  protected readonly onPodium = computed(() => {
    const rank = this.board()?.you?.rank;
    return rank !== null && rank !== undefined && rank <= PODIUM_RANKS;
  });
  // The viewer has joined but has no result yet, so they are not on the board.
  protected readonly unranked = computed(() => {
    const own = this.board()?.you;
    return !!own && own.rank === null;
  });
  private readonly sharedPlay = inject(SharedPlayService);
  private readonly audio = inject(GameAudio);
  private readonly destroyRef = inject(DestroyRef);
  private celebrated = false;
  // Requests are numbered so that a slow answer for an older one never replaces a newer board.
  private sent = 0;
  private applied = 0;
  private loadedCode: string | null = null;
  // Set by a 404 `Board hidden`: the setting never changes for an assignment, so asking again is pointless.
  private hidden = false;

  constructor() {
    effect(() => {
      const code = this.code();
      this.refreshKey();
      untracked(() => {
        if (code !== this.loadedCode) {
          // Another assignment's board must not stay on screen while this one loads.
          this.loadedCode = code;
          this.hidden = false;
          this.board.set(null);
        }
        this.load();
      });
    });
    effect(() => {
      const onPodium = this.onPodium();
      untracked(() => {
        if (onPodium && !this.celebrated) {
          this.audio.play('finish');
        }
        this.celebrated = onPodium;
      });
    });
    const timer = setInterval(() => this.loadIfVisible(), BOARD_POLL_MS);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  @HostListener('document:visibilitychange')
  protected onVisibilityChange(): void {
    this.loadIfVisible();
  }

  private loadIfVisible(): void {
    if (document.visibilityState === 'visible') {
      this.load();
    }
  }

  private load(): void {
    if (this.hidden) {
      return;
    }
    const mine = ++this.sent;
    const code = this.code();
    this.sharedPlay.leaderboard(code).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: board => {
        if (mine > this.applied && !this.hidden) {
          this.applied = mine;
          this.board.set(board);
        }
      },
      error: err => {
        // An answer for a code the component has moved off must not hide the new code's board.
        if (code === this.loadedCode && isBoardHidden(err)) {
          this.hidden = true;
          this.board.set(null);
        }
        // Any other miss: the board is a nicety next to the game, so the last one stays on screen, quietly.
      },
    });
  }
}

// Whether a failed load is the server saying the teacher hid the board (404 with that plain-text body), as
// opposed to an unknown code or a network or server error, which only leave the last board in place.
function isBoardHidden(err: unknown): boolean {
  return err instanceof HttpErrorResponse && err.status === 404
    && (typeof err.error === 'string' ? err.error.trim() : '') === BOARD_HIDDEN;
}
