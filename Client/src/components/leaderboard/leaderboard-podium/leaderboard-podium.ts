import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AvatarRing, AvatarSize, PlayerAvatar } from '../player-avatar/player-avatar';
import { MarqueeText } from '../marquee-text/marquee-text';
import { PodiumEntry, podiumSteps } from './podium';
import { medal } from '../../assignments/assignment-leaderboard/assignment-leaderboard-logic';

// Players on a step are drawn as overlapping avatars, up to this many; the rest are a "+N" chip.
const MAX_AVATARS = 3;

const RING_OF_RANK = {
  1: 'gold',
  2: 'silver',
  3: 'bronze'
} as const satisfies Record<number, AvatarRing>;

// A step as the template draws it.
interface StepView {
  rank: 1 | 2 | 3;
  column: 1 | 2 | 3;
  ring: AvatarRing;
  avatarSize: AvatarSize;
  shown: PodiumEntry[];
  extra: number;
  names: string;
  meta: string;
}

// The top three of the leaderboard as a podium: first in the middle and taller, second on its left, third on
// its right. Players tied on a rank share a step (up to three avatars that overlap, then "+N", and their
// names in one scrolling line); a rank nobody holds has no step. The steps are in rank order in the page and
// placed by their grid column, so a screen reader reads first, second, third. `large` is the projector's
// full-screen size, one and a half times everything. The list sits in the page as it is given: the caller
// decides when there is a podium to show (at least one ranked player).
@Component({
  selector: 'app-leaderboard-podium',
  imports: [MarqueeText, PlayerAvatar],
  templateUrl: './leaderboard-podium.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './leaderboard-podium.css',
  host: {
    '[class.is-large]': 'large()',
  },
})
export class LeaderboardPodium {
  readonly entries = input.required<PodiumEntry[]>();
  // How many stages the assignment has and how many answers are possible, for each step's score line.
  readonly stageCount = input.required<number>();
  readonly possible = input.required<number>();
  readonly large = input(false);

  protected readonly steps = computed((): StepView[] => podiumSteps(this.entries()).map(step => {
    // Players on one step share a rank, so they share what the rank was won with.
    const {
      stagesPassed,
      correct
    } = step.entries[0];
    return {
      rank: step.rank,
      column: step.column,
      ring: RING_OF_RANK[step.rank],
      avatarSize: step.rank === 1 ? 'xl' : 'lg',
      shown: step.entries.slice(0, MAX_AVATARS),
      extra: Math.max(0, step.entries.length - MAX_AVATARS),
      names: step.entries.map(entry => entry.name).join(' · '),
      meta: `${stagesPassed}/${this.stageCount()} màn · ${correct}/${this.possible()} câu`,
    };
  }));
  protected readonly medal = medal;
}
