import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MarqueeSettings } from '../marquee-settings.service';
import { MARQUEE_GAP_PX, MARQUEE_MOVING_SHARE, MARQUEE_SPEED_PX_PER_S, MarqueeText } from './marquee-text';

const KEY = 'leaderboard-marquee-paused';
const SHORT = 'Lan';
const LONG = 'Nguyễn Hoàng Bảo Ngọc Lan Phương Thảo Vy';

// What a stubbed matchMedia returns: a query that matches or not, whose change listeners the spec can call.
class FakeQuery {
  readonly listeners = new Set<(event: MediaQueryListEvent) => void>();

  constructor(public matches: boolean) {
  }

  addEventListener(_type: string, listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.delete(listener);
  }

  change(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) {
      listener({matches} as MediaQueryListEvent);
    }
  }
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

describe('MarqueeText', () => {
  let fixture: ComponentFixture<MarqueeText>;

  beforeEach(async () => {
    localStorage.removeItem(KEY);
    await TestBed.configureTestingModule({imports: [MarqueeText]}).compileComponents();
  });

  afterEach(() => localStorage.removeItem(KEY));

  const host = () => fixture.nativeElement as HTMLElement;
  const isScrolling = () => host().classList.contains('is-scrolling');
  const copies = () => Array.from(host().querySelectorAll<HTMLElement>('.copy'));
  const plain = () => host().querySelector<HTMLElement>('.plain');
  const track = () => host().querySelector<HTMLElement>('.track');

  // Shows `text` in a box `width` px wide, and waits for the measuring (after the first render and from the
  // resize observer, which reports a frame later).
  async function show(text: string, width: number): Promise<void> {
    fixture = TestBed.createComponent(MarqueeText);
    host().style.width = `${width}px`;
    fixture.componentRef.setInput('text', text);
    await settle();
  }

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await nextFrame();
    await nextFrame();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function resize(width: number): Promise<void> {
    host().style.width = `${width}px`;
    await settle();
  }

  describe('a name that fits', () => {
    beforeEach(() => show(SHORT, 400));

    it('is plain text, without a track or a second copy', () => {
      expect(isScrolling()).toBeFalse();
      expect(plain()?.textContent?.trim()).toBe(SHORT);
      expect(track()).toBeNull();
      expect(copies().length).toBe(0);
    });

    it('is one line that ends in an ellipsis if it ever has to be cut', () => {
      const style = getComputedStyle(plain()!);
      expect(style.overflow).toBe('hidden');
      expect(style.textOverflow).toBe('ellipsis');
      expect(getComputedStyle(host()).whiteSpace).toBe('nowrap');
      expect(getComputedStyle(host()).display).toBe('block');
    });

    it('carries the whole name in its title', () => {
      expect(host().getAttribute('title')).toBe(SHORT);
    });
  });

  describe('a name wider than its box', () => {
    beforeEach(() => show(LONG, 80));

    it('scrolls: a track with the text twice, the second copy hidden from assistive technology', () => {
      expect(isScrolling()).toBeTrue();
      expect(plain()).toBeNull();
      expect(copies().map(copy => copy.textContent?.trim())).toEqual([LONG, LONG]);
      expect(copies()[0].getAttribute('aria-hidden')).toBeNull();
      expect(copies()[1].getAttribute('aria-hidden')).toBe('true');
    });

    it('moves by the width of one copy and the gap, at 40px a second with a hold at the start of each loop', () => {
      const width = copies()[0].getBoundingClientRect().width;
      const distance = parseFloat(host().style.getPropertyValue('--marquee-distance'));
      const duration = parseFloat(host().style.getPropertyValue('--marquee-duration'));

      expect(host().style.getPropertyValue('--marquee-distance')).toMatch(/^[\d.]+px$/);
      expect(host().style.getPropertyValue('--marquee-duration')).toMatch(/^[\d.]+s$/);
      expect(width).toBeGreaterThan(80);
      expect(distance).toBeCloseTo(width + MARQUEE_GAP_PX, 0);
      // The loop moves for 88% of its duration, so the speed over that part is 40px a second.
      expect(duration).toBeCloseTo(distance / MARQUEE_SPEED_PX_PER_S / MARQUEE_MOVING_SHARE, 1);
      expect(distance / (duration * MARQUEE_MOVING_SHARE)).toBeCloseTo(MARQUEE_SPEED_PX_PER_S, 0);
    });

    it('runs one linear, endless animation of the track, with a gap of 40px between the copies', () => {
      const style = getComputedStyle(track()!);

      expect(style.animationName).toContain('marquee-scroll');
      expect(style.animationTimingFunction).toBe('linear');
      expect(style.animationIterationCount).toBe('infinite');
      expect(parseFloat(style.animationDuration)).toBeCloseTo(parseFloat(host().style.getPropertyValue('--marquee-duration')), 1);
      expect(style.willChange).toBe('transform');
      expect(style.display).toBe('inline-flex');
      expect(style.columnGap).toBe('40px');
      expect(copies()[1].getBoundingClientRect().left - copies()[0].getBoundingClientRect().right)
        .toBeCloseTo(MARQUEE_GAP_PX, 0);
    });

    it('fades its two edges and stays one clipped line', () => {
      const style = getComputedStyle(host());

      expect(style.maskImage).toContain('linear-gradient');
      expect(style.overflow).toBe('hidden');
      expect(style.whiteSpace).toBe('nowrap');
    });

    it('carries the whole name in its title', () => {
      expect(host().getAttribute('title')).toBe(LONG);
    });

    it('stops when the box grows enough to hold the name, and starts again when it shrinks', async () => {
      await resize(700);
      expect(isScrolling()).toBeFalse();
      expect(plain()?.textContent?.trim()).toBe(LONG);

      await resize(80);
      expect(isScrolling()).toBeTrue();
    });

    it('stops when the text becomes short, and starts when it becomes long again', async () => {
      fixture.componentRef.setInput('text', SHORT);
      await settle();
      expect(isScrolling()).toBeFalse();
      expect(host().getAttribute('title')).toBe(SHORT);

      fixture.componentRef.setInput('text', LONG);
      await settle();
      expect(isScrolling()).toBeTrue();
    });

    it('stays still, with an ellipsis, while names are paused, and runs again when they are not', async () => {
      const settings = TestBed.inject(MarqueeSettings);

      settings.setPaused(true);
      fixture.detectChanges();
      expect(isScrolling()).toBeFalse();
      expect(track()).toBeNull();
      expect(plain()?.textContent?.trim()).toBe(LONG);
      expect(getComputedStyle(plain()!).textOverflow).toBe('ellipsis');
      // Cut by the box: the text is wider than what is shown.
      expect(plain()!.scrollWidth).toBeGreaterThan(plain()!.clientWidth);

      settings.setPaused(false);
      fixture.detectChanges();
      expect(isScrolling()).toBeTrue();
    });

    it('stops its measuring when destroyed', () => {
      const disconnect = spyOn(ResizeObserver.prototype, 'disconnect').and.callThrough();

      fixture.destroy();

      expect(disconnect).toHaveBeenCalled();
    });
  });

  describe('with reduced motion', () => {
    let query: FakeQuery;

    beforeEach(() => {
      query = new FakeQuery(true);
      spyOn(window, 'matchMedia').and.returnValue(query as unknown as MediaQueryList);
    });

    it('asks for the reduced-motion preference', async () => {
      await show(LONG, 80);

      expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    });

    it('does not scroll, and cuts the name with an ellipsis', async () => {
      await show(LONG, 80);

      expect(isScrolling()).toBeFalse();
      expect(track()).toBeNull();
      expect(getComputedStyle(plain()!).textOverflow).toBe('ellipsis');
      expect(host().getAttribute('title')).toBe(LONG);
    });

    it('follows the preference when it changes while the page is open', async () => {
      await show(LONG, 80);

      query.change(false);
      fixture.detectChanges();
      expect(isScrolling()).toBeTrue();

      query.change(true);
      fixture.detectChanges();
      expect(isScrolling()).toBeFalse();
    });

    it('stops listening when destroyed', async () => {
      await show(LONG, 80);
      expect(query.listeners.size).toBe(1);

      fixture.destroy();

      expect(query.listeners.size).toBe(0);
    });
  });

  describe('where the browser lacks the measuring tools', () => {
    // Takes a global away for the duration of `run`, then puts it back.
    async function without(target: object, name: string, run: () => Promise<void>): Promise<void> {
      const own = Object.getOwnPropertyDescriptor(target, name);
      Object.defineProperty(target, name, {value: undefined, configurable: true, writable: true});
      try {
        await run();
      } finally {
        if (own) {
          Object.defineProperty(target, name, own);
        } else {
          delete (target as Record<string, unknown>)[name];
        }
      }
    }

    it('still measures once on init, without ResizeObserver, matchMedia or document.fonts', async () => {
      await without(window, 'ResizeObserver', () => without(window, 'matchMedia', () => without(document, 'fonts', async () => {
        await show(LONG, 80);

        expect(isScrolling()).toBeTrue();
        expect(host().textContent).toContain(LONG);
        expect(host().getAttribute('title')).toBe(LONG);

        fixture.destroy();
      })));
    });

    it('shows a name that fits plainly in the same conditions', async () => {
      await without(window, 'ResizeObserver', () => without(window, 'matchMedia', () => without(document, 'fonts', async () => {
        await show(SHORT, 400);

        expect(isScrolling()).toBeFalse();
        expect(plain()?.textContent?.trim()).toBe(SHORT);
      })));
    });
  });
});
