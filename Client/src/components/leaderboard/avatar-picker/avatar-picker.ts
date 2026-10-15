import { ChangeDetectionStrategy, Component, computed, ElementRef, model, viewChildren } from '@angular/core';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { AVATARS, randomAvatar } from '../../../models/avatar';
import { PlayerAvatar } from '../player-avatar/player-avatar';

// The grid has six columns, so ArrowUp and ArrowDown move by a row.
const COLUMNS = 6;

// Picks one of the 24 avatars: a grid of radio buttons that works with mouse, touch and keyboard, and a
// "Ngẫu nhiên" button for a random one. `value` is the picked avatar's id, '' for none yet (`[(value)]`).
// It is one radio group with a roving tabindex: Tab enters it once, on the picked avatar (or the first when
// none is), and the arrow keys, Home and End move the focus and the choice together, as native radios do.
@Component({
  selector: 'app-avatar-picker',
  imports: [NzButtonComponent, PlayerAvatar],
  templateUrl: './avatar-picker.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './avatar-picker.css',
})
export class AvatarPicker {
  readonly value = model('');

  protected readonly avatars = AVATARS;
  // The one avatar in the tab order: the picked one, or the first while nothing (or something unknown) is picked.
  protected readonly tabbable = computed(() =>
    AVATARS.some(avatar => avatar.id === this.value()) ? this.value() : AVATARS[0].id);

  private readonly cells = viewChildren<ElementRef<HTMLButtonElement>>('cell');

  protected select(id: string): void {
    this.value.set(id);
  }

  protected onKeydown(event: KeyboardEvent, index: number): void {
    const target = this.targetOf(event.key, index);
    if (target === null) {
      return;
    }
    event.preventDefault();
    this.select(AVATARS[target].id);
    this.cells()[target]?.nativeElement.focus();
  }

  protected random(): void {
    this.value.set(randomAvatar(Math.random, this.value()));
  }

  // Where a key goes from the avatar at `index`, or null for a key the group does not use. Left and right go
  // round the ends like a radio group; up and down stop at the first and last rows.
  private targetOf(key: string, index: number): number | null {
    const last = AVATARS.length - 1;
    switch (key) {
      case 'ArrowLeft':
        return index === 0 ? last : index - 1;
      case 'ArrowRight':
        return index === last ? 0 : index + 1;
      case 'ArrowUp':
        return Math.max(0, index - COLUMNS);
      case 'ArrowDown':
        return Math.min(last, index + COLUMNS);
      case 'Home':
        return 0;
      case 'End':
        return last;
      default:
        return null;
    }
  }
}
