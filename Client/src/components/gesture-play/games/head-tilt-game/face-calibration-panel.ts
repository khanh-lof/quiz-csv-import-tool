import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NzButtonComponent } from 'ng-zorro-antd/button';

import type { CalibrationStatus } from './face-common';
import { calibrationMessage } from './face-common';

// The calibration prompt shared by the two face games: while the player's neutral pose is being
// measured it shows what the camera needs (look straight, one face, come closer) with a bar for the
// second of steady looking; once calibrated it shrinks to a small "calibrate again" button.
@Component({
  selector: 'app-face-calibration',
  imports: [NzButtonComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (calibrating()) {
      <div class="card" role="status">
        <p class="message" [class.warn]="warn()">{{ message() }}</p>
        <div class="bar"><i [style.width.%]="progress() * 100"></i></div>
      </div>
    } @else {
      <button nz-button nzSize="small" type="button" (click)="recalibrate.emit()">
        Hiệu chỉnh lại
      </button>
    }
  `,
  styles: `
    :host {
      display: inline-block;
    }
    .card {
      width: min(320px, 80cqw, 100%);
      padding: 8px 14px 10px;
      text-align: center;
      background: #fff;
      border: 3px solid rgba(255, 255, 255, 0.9);
      border-radius: var(--qt-radius-lg);
      box-shadow: var(--qt-card-shadow);
    }
    .message {
      margin: 0 0 6px;
      font-size: 0.9rem;
      font-weight: 700;
      color: var(--play-ink);
    }
    .message.warn {
      color: var(--play-bad-dark);
    }
    .bar {
      height: 8px;
      overflow: hidden;
      background: #e5e7eb;
      border-radius: 999px;
    }
    .bar i {
      display: block;
      height: 100%;
      background: var(--play-charge);
      border-radius: 999px;
      transition: width 0.1s linear;
    }
  `,
})
export class FaceCalibrationPanel {
  // True while the game is not ready: the card is shown instead of the button.
  readonly calibrating = input.required<boolean>();
  readonly status = input<CalibrationStatus>('collecting');
  // 0..1 of the second of steady looking.
  readonly progress = input(0);

  readonly recalibrate = output<void>();

  protected readonly message = computed(() => calibrationMessage(this.status(), this.progress()));
  protected readonly warn = computed(
    () => this.status() === 'no-face' || this.status() === 'many-faces',
  );
}
