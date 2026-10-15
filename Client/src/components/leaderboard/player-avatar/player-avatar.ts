import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { avatarDef } from '../../../models/avatar';

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';
export type AvatarRing = 'gold' | 'silver' | 'bronze';

// A student's avatar: the emoji of their picked animal on a soft coloured disc, or, for a student with no
// avatar (or one this client does not know), the first letter of their name on a neutral disc. It is always
// drawn next to the name, so it is hidden from assistive technology. The sizes are 28, 36, 56 and 88 px; a
// page that needs another one sets `--avatar-size` on the element or on an ancestor (the podium does), and
// `ring` draws a medal-coloured border for the podium.
@Component({
  selector: 'app-player-avatar',
  templateUrl: './player-avatar.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './player-avatar.css',
  host: {
    'aria-hidden': 'true',
    '[attr.data-size]': 'size()',
    '[attr.data-ring]': 'ring()',
    '[style.--avatar-color]': 'def()?.color ?? null',
  },
})
export class PlayerAvatar {
  // The id of one of `AVATARS`; '' or an unknown id shows the letter fallback.
  readonly avatar = input('');
  readonly name = input('');
  readonly size = input<AvatarSize>('md');
  readonly ring = input<AvatarRing | null>(null);

  protected readonly def = computed(() => avatarDef(this.avatar()));
  // The fallback is a grapheme-ish first character (a code point, so an accented or astral first letter is
  // kept whole), upper-cased, or '?' for a student with no name.
  protected readonly letter = computed(() => Array.from(this.name().trim())[0]?.toUpperCase() ?? '?');
}
