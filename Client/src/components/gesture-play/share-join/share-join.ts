import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { formatClose } from '../../../models/assignment';

// The screen a student sees on opening a shared quiz for the first time: what the quiz is and a field for
// the name they will appear under in the teacher's ranking. It only collects the name: joining, and what to
// say when the name is taken, are the page's, which passes the reason back in `error`.
@Component({
  selector: 'app-share-join',
  imports: [FormsModule, NzButtonComponent, NzInputDirective],
  templateUrl: './share-join.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './share-join.css',
})
export class ShareJoin {
  readonly title = input.required<string>();
  readonly label = input('');
  readonly closesAt = input<string | null>(null);
  readonly error = input('');
  readonly busy = input(false);
  readonly join = output<string>();

  protected readonly name = signal('');
  protected readonly trimmed = computed(() => this.name().trim());
  protected readonly closeText = computed(() => {
    const closesAt = this.closesAt();
    return closesAt ? formatClose(closesAt) : '';
  });

  private readonly nameInput = viewChild.required<ElementRef<HTMLInputElement>>('nameInput');

  constructor() {
    // The `autofocus` attribute only works on the page's first load, and this screen is rendered later.
    afterNextRender(() => this.nameInput().nativeElement.focus());
  }

  protected submit(): void {
    const name = this.trimmed();
    if (name !== '' && !this.busy()) {
      this.join.emit(name);
    }
  }

  // Enter that picks a word in the middle of typing (a phone's keyboard, an input method) is not a submit.
  protected onEnter(event: Event): void {
    if (!(event as KeyboardEvent).isComposing) {
      event.preventDefault();
      this.submit();
    }
  }
}
