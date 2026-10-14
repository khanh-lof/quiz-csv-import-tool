import { ChangeDetectionStrategy, Component, computed, effect, model, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DisabledTimeConfig, NzDatePickerComponent } from 'ng-zorro-antd/date-picker';
import { NZ_I18N, vi_VN } from 'ng-zorro-antd/i18n';
import { NzRadioComponent, NzRadioGroupComponent } from 'ng-zorro-antd/radio';
import { formatClose } from '../../../models/assignment';
import { DeadlinePreset, deadlineFromPreset } from './deadline-picker-logic';

// Chooses when an assignment closes: a preset, or a time of the teacher's own. `value` is the closing time
// (null for none) and is written every time the choice changes; a value set from outside (a dialog that
// starts over, or one that edits an existing closing time) is shown as the custom time.
@Component({
  selector: 'app-deadline-picker',
  imports: [FormsModule, NzDatePickerComponent, NzRadioComponent, NzRadioGroupComponent],
  providers: [{provide: NZ_I18N, useValue: vi_VN}],
  templateUrl: './deadline-picker.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './deadline-picker.css',
})
export class DeadlinePicker {
  readonly value = model<Date | null>(null);

  protected readonly preset = signal<DeadlinePreset>('none');
  // The date picker's value, null while the teacher has not picked a time.
  protected readonly customDate = signal<Date | null>(null);

  protected readonly closeText = computed(() => {
    const value = this.value();
    return value ? `Đóng lúc ${formatClose(value)}` : '';
  });
  // A closing time in the past would close the link at once, and the server refuses it.
  protected readonly inThePast = computed(() => {
    const value = this.value();
    return value !== null && value.getTime() <= Date.now();
  });

  // What this picker last wrote to `value`, to tell its own writes from a change made from outside.
  private written: Date | null = null;

  constructor() {
    effect(() => {
      const value = this.value();
      untracked(() => {
        if (value === this.written) {
          return;
        }
        this.written = value;
        if (value === null) {
          this.preset.set('none');
          this.customDate.set(null);
        } else {
          this.preset.set('custom');
          this.customDate.set(value);
        }
      });
    });
  }

  protected setPreset(preset: DeadlinePreset): void {
    this.preset.set(preset);
    this.write();
  }

  protected setCustom(date: Date | null): void {
    this.customDate.set(date);
    this.write();
  }

  // The picker offers no day before today.
  protected readonly disabledDate = (day: Date): boolean => {
    const today = new Date();
    return day.getTime() < new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  };

  // On today, nor an hour or minute that has already gone by.
  protected readonly disabledTime = (current: Date | Date[]): DisabledTimeConfig | undefined => {
    const day = Array.isArray(current) ? current[0] : current;
    const now = new Date();
    if (!day || day.toDateString() !== now.toDateString()) {
      return undefined;
    }
    const range = (end: number) => Array.from({length: end}, (_, i) => i);
    return {
      nzDisabledHours: () => range(now.getHours()),
      nzDisabledMinutes: hour => (hour === now.getHours() ? range(now.getMinutes() + 1) : []),
      nzDisabledSeconds: () => [],
    };
  };

  private write(): void {
    const deadline = deadlineFromPreset(this.preset(), new Date(), this.customDate());
    this.written = deadline;
    this.value.set(deadline);
  }
}
