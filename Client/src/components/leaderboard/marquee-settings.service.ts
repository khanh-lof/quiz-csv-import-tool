import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'leaderboard-marquee-paused';

// Blocked storage (a private window, a browser setting) must not break the page: it reads as "not paused" and
// a choice made then lasts until the page is closed, in the signal.
function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

// Whether the leaderboard's long names stay still instead of scrolling. A scrolling name is moving content
// that lasts more than five seconds, so WCAG 2.2.2 asks for a way to stop it; every `MarqueeText` reads this
// and the `MarqueePauseButton` changes it. The choice is the user's own and is kept in the browser.
@Injectable({ providedIn: 'root' })
export class MarqueeSettings {
  private readonly state = signal(readStored());

  readonly paused = this.state.asReadonly();

  toggle(): void {
    this.setPaused(!this.state());
  }

  setPaused(paused: boolean): void {
    this.state.set(paused);
    try {
      localStorage.setItem(STORAGE_KEY, paused ? '1' : '0');
    } catch {
      // Not stored: the signal still holds the choice for this visit.
    }
  }
}
