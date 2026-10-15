import { fakeAsync, tick } from '@angular/core/testing';
import { captureRows, playFlip, prefersReducedMotion } from './flip';

describe('flip', () => {
  let container: HTMLElement;

  // Three rows, 30px tall each, one under the other, in the document so they have a place.
  beforeEach(() => {
    container = document.createElement('ol');
    container.style.cssText = 'margin: 0; padding: 0; list-style: none;';
    for (const id of ['a', 'b', 'c']) {
      const row = document.createElement('li');
      row.dataset['playerId'] = id;
      row.style.cssText = 'height: 30px;';
      container.appendChild(row);
    }
    document.body.appendChild(container);
  });

  afterEach(() => container.remove());

  const row = (id: string) => container.querySelector<HTMLElement>(`[data-player-id="${id}"]`)!;

  // Moves row `a` below the others, which puts `b` and `c` 30px higher and `a` 60px lower.
  function moveAToTheEnd(): void {
    container.appendChild(row('a'));
  }

  describe('captureRows', () => {
    it('takes the place of every row by player id', () => {
      const rects = captureRows(container);

      expect([...rects.keys()]).toEqual(['a', 'b', 'c']);
      expect(rects.get('b')!.top - rects.get('a')!.top).toBe(30);
    });

    it('ignores what is not a row', () => {
      container.appendChild(document.createElement('li'));

      expect(captureRows(container).size).toBe(3);
    });
  });

  describe('playFlip', () => {
    it('puts a row that moved back where it was, then slides it to its new place', () => {
      const before = captureRows(container);
      moveAToTheEnd();

      playFlip(container, before, 5000);

      // Right after the call the transition has only just begun: the row is still shown at its old place.
      expect(row('a').style.transition).toContain('transform');
      expect(getComputedStyle(row('a')).transform).not.toBe('none');
      expect(row('a').style.transform).toBe('none');
    });

    it('moves the rows that were pushed up too', () => {
      const before = captureRows(container);
      moveAToTheEnd();

      playFlip(container, before, 5000);

      expect(row('b').style.transition).toContain('transform');
      expect(row('c').style.transition).toContain('transform');
    });

    it('cleans the inline styles up when the transition ends', () => {
      const before = captureRows(container);
      moveAToTheEnd();
      playFlip(container, before, 5000);

      row('a').dispatchEvent(new TransitionEvent('transitionend', {propertyName: 'transform'}));

      expect(row('a').style.transform).toBe('');
      expect(row('a').style.transition).toBe('');
      // The others have not finished.
      expect(row('b').style.transition).toContain('transform');
    });

    it('ignores the end of another property, such as the hover tint', () => {
      const before = captureRows(container);
      moveAToTheEnd();
      playFlip(container, before, 5000);

      row('a').dispatchEvent(new TransitionEvent('transitionend', {propertyName: 'background-color'}));

      expect(row('a').style.transition).toContain('transform');
    });

    it('cleans up after the transition should have ended even if the event never comes', fakeAsync(() => {
      const before = captureRows(container);
      moveAToTheEnd();
      playFlip(container, before, 400);

      tick(399);
      expect(row('a').style.transition).toContain('transform');
      tick(100);

      for (const id of ['a', 'b', 'c']) {
        expect(row(id).style.transform).toBe('');
        expect(row(id).style.transition).toBe('');
      }
    }));

    it('leaves a row with no earlier place untouched', () => {
      const before = captureRows(container);
      before.delete('b');
      moveAToTheEnd();

      playFlip(container, before, 5000);

      expect(row('b').style.cssText).toBe('height: 30px;');
      expect(row('a').style.transition).toContain('transform');
    });

    it('leaves a row that did not move untouched', () => {
      const before = captureRows(container);

      playFlip(container, before, 5000);

      for (const id of ['a', 'b', 'c']) {
        expect(row(id).style.cssText).toBe('height: 30px;');
      }
    });

    it('measures a row that is still moving from an earlier call at its new place, not at its offset', () => {
      const first = captureRows(container);
      moveAToTheEnd();
      playFlip(container, first, 5000);
      // Order is now b, c, a, with `a` still shown at the top. `c` goes to the front while it slides: `a`'s new
      // place is the bottom, and it is measured there (not at the top, where its old offset still holds it).
      const second = captureRows(container);
      container.insertBefore(row('c'), row('b'));

      playFlip(container, second, 5000);

      expect(row('a').style.transition).toContain('transform');
      expect(getComputedStyle(row('a')).transform).not.toBe('none');
    });
  });

  describe('prefersReducedMotion', () => {
    it('follows the media query', () => {
      spyOn(window, 'matchMedia').and.returnValue({matches: true} as MediaQueryList);

      expect(prefersReducedMotion()).toBeTrue();
      expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    });

    it('is false when the visitor has no such preference', () => {
      spyOn(window, 'matchMedia').and.returnValue({matches: false} as MediaQueryList);

      expect(prefersReducedMotion()).toBeFalse();
    });
  });
});
