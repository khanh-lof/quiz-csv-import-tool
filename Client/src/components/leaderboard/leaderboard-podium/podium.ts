// What the podium needs to know about a ranked player. `key` identifies the player for the template's
// `track` (a teacher's page has the player id, a student's page has none and uses the name).
export interface PodiumEntry {
  key: string;
  rank: number;
  name: string;
  avatar: string;
  stagesPassed: number;
  correct: number;
}

// One step of the podium: the players who share a rank, and the grid column it stands in.
export interface PodiumStep {
  rank: 1 | 2 | 3;
  column: 1 | 2 | 3;
  entries: PodiumEntry[];
}

// The classic podium puts the winner in the middle, with second on the left and third on the right.
const COLUMN_OF_RANK = {
  1: 2,
  2: 1,
  3: 3
} as const;

// The podium's steps, in rank order (which is the order a screen reader should read them in; the columns
// put them in place). Players tied on a rank stand on one step, in the order given. A rank nobody holds has
// no step: after a tie for first (1, 1, 3) the podium has a first and a third and nothing between them,
// which is how a race is scored. Players ranked below third are not on the podium.
export function podiumSteps(entries: readonly PodiumEntry[]): PodiumStep[] {
  const steps: PodiumStep[] = [];
  for (const rank of [1, 2, 3] as const) {
    const onStep = entries.filter(entry => entry.rank === rank);
    if (onStep.length > 0) {
      steps.push({
        rank,
        column: COLUMN_OF_RANK[rank],
        entries: onStep
      });
    }
  }
  return steps;
}
