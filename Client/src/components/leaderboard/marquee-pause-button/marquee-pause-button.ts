import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { MarqueeSettings } from '../marquee-settings.service';

// The switch that stops, or starts again, every scrolling name on the leaderboard ("Dừng chữ chạy"): the
// way out of moving text that WCAG 2.2.2 asks for. It is a toggle button over `MarqueeSettings`, so it can
// sit on any page that shows the leaderboard. `compact` shows only the icon, for a tight header; the words
// then go to the accessible name and the tooltip.
@Component({
  selector: 'app-marquee-pause-button',
  imports: [NzButtonComponent, NzIconDirective],
  templateUrl: './marquee-pause-button.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class MarqueePauseButton {
  readonly compact = input(false);
  // What a click does, not the state: running names offer to stop, stopped ones to start.
  protected readonly label = computed(() => (this.paused() ? 'Cho chữ chạy' : 'Dừng chữ chạy'));
  private readonly settings = inject(MarqueeSettings);
  protected readonly paused = this.settings.paused;

  protected toggle(): void {
    this.settings.toggle();
  }
}
