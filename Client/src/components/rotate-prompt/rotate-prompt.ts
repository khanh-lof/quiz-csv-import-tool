import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import type { MessageKey } from '../../i18n/messages';
import { MessagePipe } from '../../i18n/messages';

export type ScreenOrientationWanted = 'landscape' | 'portrait';

// A phone held the other way round from the one the page is made for: upright for a landscape page, on its
// side for a portrait one.
const WRONG_WAY: Record<ScreenOrientationWanted, string> = {
  landscape: '(orientation: portrait) and (pointer: coarse) and (max-width: 600px)',
  portrait: '(orientation: landscape) and (pointer: coarse) and (max-height: 600px)',
};

// TypeScript's DOM types dropped `lock`, which Chromium on Android still has (Safari never had it).
type LockableOrientation = ScreenOrientation & { lock?: (orientation: ScreenOrientationWanted) => Promise<void> };

function canLockOrientation(): boolean {
  return typeof screen !== 'undefined'
    && typeof (screen.orientation as LockableOrientation | undefined)?.lock === 'function'
    && document.fullscreenEnabled;
}

// Asks a phone held the wrong way to turn, and says nothing otherwise. Where the browser can turn the screen
// itself it is a button that full-screens `fullscreenTarget` and locks the orientation; elsewhere a line of text.
@Component({
  selector: 'kt-quiz-rotate-prompt',
  imports: [NzButtonComponent, MessagePipe],
  templateUrl: './rotate-prompt.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './rotate-prompt.css',
})
export class RotatePrompt implements OnInit {
  readonly to = input.required<ScreenOrientationWanted>();
  readonly fullscreenTarget = input<HTMLElement | undefined>(undefined);

  protected readonly wrongWay = signal(false);
  protected readonly label = computed<MessageKey>(() =>
    this.to() === 'landscape' ? 'play.rotate.landscape' : 'play.rotate.portrait');
  readonly canLock = canLockOrientation();

  private readonly destroyRef = inject(DestroyRef);

  ngOnInit(): void {
    if (typeof matchMedia !== 'function') {
      return;
    }
    const query = matchMedia(WRONG_WAY[this.to()]);
    const update = () => this.wrongWay.set(query.matches);
    update();
    query.addEventListener('change', update);
    this.destroyRef.onDestroy(() => query.removeEventListener('change', update));
  }

  // The browser only turns the screen from a page in full screen, and lets go of it when full screen ends.
  protected rotate(): void {
    const turn = () => (screen.orientation as LockableOrientation).lock?.(this.to()).catch(() => undefined);
    if (document.fullscreenElement) {
      turn();
      return;
    }
    this.fullscreenTarget()?.requestFullscreen().then(turn, () => undefined);
  }
}
