import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LeaderboardPodium } from './leaderboard-podium';
import { PodiumEntry } from './podium';

function entry(rank: number, name: string, overrides: Partial<PodiumEntry> = {}): PodiumEntry {
  return {
    key: name,
    rank,
    name,
    avatar: 'cat',
    stagesPassed: 2,
    correct: 9, ...overrides
  };
}

describe('LeaderboardPodium', () => {
  let fixture: ComponentFixture<LeaderboardPodium>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [LeaderboardPodium] }).compileComponents();
    fixture = TestBed.createComponent(LeaderboardPodium);
  });

  function show(entries: PodiumEntry[], large = false): void {
    fixture.componentRef.setInput('entries', entries);
    fixture.componentRef.setInput('stageCount', 3);
    fixture.componentRef.setInput('possible', 15);
    fixture.componentRef.setInput('large', large);
    fixture.detectChanges();
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const podium = () => root().querySelector<HTMLElement>('ol.podium');
  const steps = () => Array.from(root().querySelectorAll<HTMLElement>('ol.podium > li'));
  const stepOf = (rank: number) => steps().find(step => step.dataset['rank'] === String(rank))!;
  const avatars = (step: HTMLElement) => Array.from(step.querySelectorAll<HTMLElement>('app-player-avatar'));
  const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, ' ').trim();

  // Under 768px the avatars are one size smaller (the phone's podium), and the window these specs run in may be
  // either.
  const phone = () => window.innerWidth < 768;
  const avatarPx = (rank: number, scale = 1) => (rank === 1 ? (phone() ? 56 : 88) : phone() ? 36 : 56) * scale;

  const THREE = [entry(1, 'Lan', { correct: 14 }), entry(2, 'Minh', {
    correct: 11,
    stagesPassed: 1
  }), entry(3, 'Hoa', {
    correct: 7,
    stagesPassed: 1
  })];

  it('is an ordered list named "Ba hạng đầu" with a step for each of the three ranks, in rank order', () => {
    show(THREE);

    expect(podium()).not.toBeNull();
    expect(podium()!.getAttribute('aria-label')).toBe('Ba hạng đầu');
    expect(steps().map(step => step.dataset['rank'])).toEqual(['1', '2', '3']);
  });

  it('places first in the middle column, second on the left and third on the right', () => {
    show(THREE);

    const columns = ['1', '2', '3'].map(rank => getComputedStyle(stepOf(Number(rank))).gridColumnStart);
    expect(columns).toEqual(['2', '1', '3']);
    const left = (rank: number) => stepOf(rank).getBoundingClientRect().left;
    expect(left(2)).toBeLessThan(left(1));
    expect(left(1)).toBeLessThan(left(3));
  });

  it('draws a three-column grid whose steps stand on one line', () => {
    show(THREE);

    expect(getComputedStyle(podium()!).display).toBe('grid');
    expect(getComputedStyle(podium()!).alignItems).toBe('end');
    const bottoms = steps().map(step => Math.round(step.getBoundingClientRect().bottom));
    expect(new Set(bottoms).size).toBe(1);
  });

  it('names each step for a screen reader with its rank', () => {
    show(THREE);

    expect(text(steps()[0].querySelector('.sr-only'))).toBe('Hạng 1:');
    expect(text(steps()[1].querySelector('.sr-only'))).toBe('Hạng 2:');
  });

  it('puts a crown over first place only', () => {
    show(THREE);

    expect(stepOf(1).querySelector('.crown')?.textContent).toBe('👑');
    expect(stepOf(1).querySelector('.crown')?.getAttribute('aria-hidden')).toBe('true');
    expect(root().querySelectorAll('.crown').length).toBe(1);
  });

  it('shows each player\'s avatar with the medal ring, first place bigger', () => {
    show(THREE);

    expect(avatars(stepOf(1)).map(avatar => [avatar.dataset['ring'], avatar.dataset['size']])).toEqual([['gold', 'xl']]);
    expect(avatars(stepOf(2)).map(avatar => [avatar.dataset['ring'], avatar.dataset['size']])).toEqual([['silver', 'lg']]);
    expect(avatars(stepOf(3)).map(avatar => [avatar.dataset['ring'], avatar.dataset['size']])).toEqual([['bronze', 'lg']]);
    expect(avatars(stepOf(1))[0].getBoundingClientRect().width).toBe(avatarPx(1));
    expect(avatars(stepOf(2))[0].getBoundingClientRect().width).toBe(avatarPx(2));
    expect(avatars(stepOf(3))[0].getBoundingClientRect().width).toBe(avatarPx(3));
  });

  it('shows the name in a marquee, and the stages and answers that won the rank', () => {
    show(THREE);

    expect(text(stepOf(1).querySelector('app-marquee-text'))).toBe('Lan');
    expect(text(stepOf(1).querySelector('.meta'))).toBe('2/3 màn · 14/15 câu');
    expect(text(stepOf(2).querySelector('.meta'))).toBe('1/3 màn · 11/15 câu');
    expect(text(stepOf(3).querySelector('.meta'))).toBe('1/3 màn · 7/15 câu');
  });

  it('stands the winner on the tallest plinth, 100, 70 and 54 px high, with its medal on it', () => {
    show(THREE);

    const plinth = (rank: number) => stepOf(rank).querySelector<HTMLElement>('.plinth')!;
    expect([1, 2, 3].map(rank => plinth(rank).getBoundingClientRect().height)).toEqual([100, 70, 54]);
    expect([1, 2, 3].map(rank => text(plinth(rank)))).toEqual(['🥇', '🥈', '🥉']);
    expect(plinth(1).getAttribute('aria-hidden')).toBe('true');
  });

  it('colours each plinth with its medal: a soft fill and a top border in the metal', () => {
    show(THREE);

    const colours = (rank: number) => {
      const style = getComputedStyle(stepOf(rank).querySelector('.plinth')!);
      return [style.backgroundColor, style.borderTopColor];
    };
    expect(colours(1)).toEqual(['rgb(255, 244, 204)', 'rgb(245, 179, 1)']);
    expect(colours(2)).toEqual(['rgb(238, 241, 245)', 'rgb(168, 178, 193)']);
    expect(colours(3)).toEqual(['rgb(251, 231, 218)', 'rgb(205, 127, 74)']);
  });

  describe('large (the projector)', () => {
    it('scales the plinths and the avatars by one and a half', () => {
      show(THREE, true);

      const height = (rank: number) => stepOf(rank).querySelector('.plinth')!.getBoundingClientRect().height;
      expect([1, 2, 3].map(height)).toEqual([150, 105, 81]);
      expect(avatars(stepOf(1))[0].getBoundingClientRect().width).toBe(avatarPx(1, 1.5));
      expect(avatars(stepOf(2))[0].getBoundingClientRect().width).toBe(avatarPx(2, 1.5));
      expect(root().classList).toContain('is-large');
    });

    it('is the normal size by default', () => {
      show(THREE);

      expect(root().classList).not.toContain('is-large');
    });
  });

  describe('a tie', () => {
    it('puts players tied for first on one step, with one avatar each and all names in one marquee', () => {
      show([entry(1, 'Lan'), entry(1, 'Minh'), entry(3, 'Hoa')]);

      expect(steps().map(step => step.dataset['rank'])).toEqual(['1', '3']);
      expect(getComputedStyle(stepOf(1)).gridColumnStart).toBe('2');
      expect(getComputedStyle(stepOf(3)).gridColumnStart).toBe('3');
      expect(avatars(stepOf(1)).length).toBe(2);
      const names = stepOf(1).querySelector('app-marquee-text')!;
      expect(text(names)).toBe('Lan · Minh');
      expect(names.getAttribute('title')).toBe('Lan · Minh');
      expect(stepOf(1).querySelector('.more')).toBeNull();
    });

    it('puts players tied for second on one step', () => {
      show([entry(1, 'Lan'), entry(2, 'Minh'), entry(2, 'Hoa')]);

      expect(steps().map(step => step.dataset['rank'])).toEqual(['1', '2']);
      expect(text(stepOf(2).querySelector('app-marquee-text'))).toBe('Minh · Hoa');
    });

    it('draws three avatars and a "+N" chip for more players, and still lists every name', () => {
      show([entry(1, 'Lan'), entry(1, 'Minh'), entry(1, 'Hoa'), entry(1, 'Bảo'), entry(1, 'An'), entry(6, 'Vy')]);

      expect(avatars(stepOf(1)).length).toBe(3);
      expect(text(stepOf(1).querySelector('.more'))).toBe('+2');
      expect(text(stepOf(1).querySelector('app-marquee-text'))).toBe('Lan · Minh · Hoa · Bảo · An');
      expect(steps().length).toBe(1);
    });

    it('has no chip for exactly three players', () => {
      show([entry(1, 'Lan'), entry(1, 'Minh'), entry(1, 'Hoa')]);

      expect(avatars(stepOf(1)).length).toBe(3);
      expect(stepOf(1).querySelector('.more')).toBeNull();
    });

    it('overlaps the avatars of a step', () => {
      show([entry(1, 'Lan'), entry(1, 'Minh')]);

      const [first, second] = avatars(stepOf(1)).map(avatar => avatar.getBoundingClientRect());
      expect(second.left).toBeLessThan(first.right);
    });
  });

  describe('fewer than three ranked', () => {
    it('has only the steps of the ranks that are held', () => {
      show([entry(1, 'Lan')]);

      expect(steps().map(step => step.dataset['rank'])).toEqual(['1']);
      expect(getComputedStyle(stepOf(1)).gridColumnStart).toBe('2');
    });

    it('ignores players below third', () => {
      show([entry(1, 'Lan'), entry(4, 'Bảo'), entry(5, 'An')]);

      expect(steps().length).toBe(1);
      expect(root().textContent).not.toContain('Bảo');
    });

    it('draws nothing without a ranked player', () => {
      show([]);

      expect(podium()).toBeNull();
      expect(text(root())).toBe('');
    });
  });

  it('follows its inputs: the meta line changes with the stage count and the points possible', () => {
    show(THREE);

    fixture.componentRef.setInput('stageCount', 6);
    fixture.componentRef.setInput('possible', 30);
    fixture.detectChanges();

    expect(text(stepOf(1).querySelector('.meta'))).toBe('2/6 màn · 14/30 câu');
  });
});
