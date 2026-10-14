import { ChangeDetectionStrategy, Component, computed, effect, model, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { NzRadioComponent, NzRadioGroupComponent } from 'ng-zorro-antd/radio';
import { formatClose } from '../../../models/assignment';
import {
  DeadlinePreset,
  deadlineFromPreset,
  fromLocalInputValue,
  toLocalInputValue,
} from './deadline-picker-logic';

// Chooses when an assignment closes: a preset, or a time of the teacher's own. `value` is the closing time
// (null for none) and is written every time the choice changes; a value set from outside (a dialog that
// starts over, or one that edits an existing closing time) is shown as the custom time.
@Component({
  selector: 'app-deadline-picker',
  imports: [FormsModule, NzInputDirective, NzRadioComponent, NzRadioGroupComponent],
  templateUrl: './deadline-picker.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './deadline-picker.css',
})
export class DeadlinePicker {
  readonly value = model<Date | null>(null);

  protected readonly preset = signal<DeadlinePreset>('none');
  // The text of the datetime-local input, which is '' while the teacher has not completed a time.
  protected readonly customText = signal('');
  // The earliest time the input accepts: the moment the custom choice was made.
  protected readonly minText = signal(toLocalInputValue(new Date()));

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
          this.customText.set('');
        } else {
          this.preset.set('custom');
          this.customText.set(toLocalInputValue(value));
          this.minText.set(toLocalInputValue(new Date()));
        }
      });
    });
  }

  protected setPreset(preset: DeadlinePreset): void {
    this.preset.set(preset);
    if (preset === 'custom') {
      this.minText.set(toLocalInputValue(new Date()));
    }
    this.write();
  }

  protected setCustom(text: string): void {
    this.customText.set(text);
    this.write();
  }

  private write(): void {
    const deadline = deadlineFromPreset(this.preset(), new Date(), fromLocalInputValue(this.customText()));
    this.written = deadline;
    this.value.set(deadline);
  }
}
