import { PodiumEntry, podiumSteps } from './podium';

function entry(rank: number, name: string): PodiumEntry {
  return {
    key: name,
    rank,
    name,
    avatar: '',
    stagesPassed: 1,
    correct: 5
  };
}

const summary = (entries: PodiumEntry[]) =>
  podiumSteps(entries).map(step => ({
    rank: step.rank,
    column: step.column,
    names: step.entries.map(e => e.name)
  }));

describe('podiumSteps', () => {
  it('gives each of the first three ranks a step, in rank order, the winner in the middle column', () => {
    expect(summary([entry(1, 'Lan'), entry(2, 'Minh'), entry(3, 'Hoa')])).toEqual([
      {
        rank: 1,
        column: 2,
        names: ['Lan']
      },
      {
        rank: 2,
        column: 1,
        names: ['Minh']
      },
      {
        rank: 3,
        column: 3,
        names: ['Hoa']
      },
    ]);
  });

  it('puts players tied for first on one step and leaves out the rank nobody holds', () => {
    expect(summary([entry(1, 'Lan'), entry(1, 'Minh'), entry(3, 'Hoa')])).toEqual([
      {
        rank: 1,
        column: 2,
        names: ['Lan', 'Minh']
      },
      {
        rank: 3,
        column: 3,
        names: ['Hoa']
      },
    ]);
  });

  it('puts players tied for second on one step, and the next rank after them is not third', () => {
    expect(summary([entry(1, 'Lan'), entry(2, 'Minh'), entry(2, 'Hoa'), entry(4, 'Bảo')])).toEqual([
      {
        rank: 1,
        column: 2,
        names: ['Lan']
      },
      {
        rank: 2,
        column: 1,
        names: ['Minh', 'Hoa']
      },
    ]);
  });

  it('puts players tied for third on one step', () => {
    expect(summary([entry(1, 'Lan'), entry(2, 'Minh'), entry(3, 'Hoa'), entry(3, 'Bảo'), entry(3, 'An')])).toEqual([
      {
        rank: 1,
        column: 2,
        names: ['Lan']
      },
      {
        rank: 2,
        column: 1,
        names: ['Minh']
      },
      {
        rank: 3,
        column: 3,
        names: ['Hoa', 'Bảo', 'An']
      },
    ]);
  });

  it('has fewer steps when fewer than three players are ranked', () => {
    expect(summary([entry(1, 'Lan')])).toEqual([{
      rank: 1,
      column: 2,
      names: ['Lan']
    }]);
    expect(summary([entry(1, 'Lan'), entry(2, 'Minh')])).toEqual([
      {
        rank: 1,
        column: 2,
        names: ['Lan']
      },
      {
        rank: 2,
        column: 1,
        names: ['Minh']
      },
    ]);
  });

  it('ignores players below third, whatever the order', () => {
    expect(summary([entry(5, 'An'), entry(4, 'Bảo'), entry(2, 'Minh'), entry(1, 'Lan')])).toEqual([
      {
        rank: 1,
        column: 2,
        names: ['Lan']
      },
      {
        rank: 2,
        column: 1,
        names: ['Minh']
      },
    ]);
  });

  it('has no steps without anyone on the podium', () => {
    expect(podiumSteps([])).toEqual([]);
    expect(podiumSteps([entry(4, 'Bảo'), entry(5, 'An')])).toEqual([]);
  });

  it('keeps the entries of a step in the order given, and the entries themselves', () => {
    const lan = entry(1, 'Lan');
    const minh = entry(1, 'Minh');

    const [step] = podiumSteps([minh, lan]);

    expect(step.entries).toEqual([minh, lan]);
    expect(step.entries[0]).toBe(minh);
  });
});
