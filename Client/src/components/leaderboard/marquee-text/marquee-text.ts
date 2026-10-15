import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MarqueeSettings } from '../marquee-settings.service';

// The empty space between the end of the text and its repeat, and the speed the text moves at: the LED
// sign's rhythm. A loop holds still for the first part of its duration (the keyframes in the stylesheet
// hold for 12%) and moves in the rest, so the duration is stretched to keep the speed at SPEED_PX_PER_S.
export const MARQUEE_GAP_PX = 40;
export const MARQUEE_SPEED_PX_PER_S = 40;
export const MARQUEE_MOVING_SHARE = 0.88;

// A one-line name that scrolls only when it does not fit. A name that fits is plain text. One that is wider
// than its box runs right to left in a seamless loop, like an LED ad sign: the text twice in a row, moved by
// the width of one copy and its gap. It stays still, with an ellipsis, while the user has paused names
// (`MarqueeSettings`) or asks for reduced motion, and while the pointer is over it; the whole name is always
// in `title`. The box is whatever the parent gives the element, which is measured on init, when the text
// changes, when the box is resized and once the fonts have loaded (the width of the text changes with them).
@Component({
  selector: 'app-marquee-text',
  templateUrl: './marquee-text.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './marquee-text.css',
  host: {
    '[attr.title]': 'text()',
    '[class.is-scrolling]': 'scrolling()',
    '[style.--marquee-distance]': 'distance() + "px"',
    '[style.--marquee-duration]': 'duration() + "s"',
  },
})
export class MarqueeText {
  readonly text = input.required<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly destroyRef = inject(DestroyRef);
  private readonly settings = inject(MarqueeSettings);

  // Whether the text is wider than the box, and the text's own width as last measured.
  private readonly overflowing = signal(false);
  private readonly textWidth = signal(0);
  private readonly reducedMotion = signal(false);

  protected readonly scrolling = computed(() => this.overflowing() && !this.settings.paused() && !this.reducedMotion());
  // How far the track moves per loop: one copy of the text and the gap after it.
  protected readonly distance = computed(() => this.textWidth() + MARQUEE_GAP_PX);
  protected readonly duration = computed(() =>
    Math.round((this.distance() / MARQUEE_SPEED_PX_PER_S / MARQUEE_MOVING_SHARE) * 100) / 100);

  constructor() {
    // Measure after the first render and after every render that follows a change of the text.
    afterRenderEffect(() => {
      this.text();
      untracked(() => this.measure());
    });
    this.watchBox();
    this.watchFonts();
    this.watchReducedMotion();
  }

  // The text's natural width against the box's: a plain span reports it as its scrollWidth (it clips with an
  // ellipsis), a scrolling track as the width of its first copy. A box with no width (not shown) cannot tell.
  private measure(): void {
    const boxWidth = this.host.clientWidth;
    const plain = this.host.querySelector<HTMLElement>('.plain');
    const copy = this.host.querySelector<HTMLElement>('.copy');
    const width = plain ? plain.scrollWidth : copy ? copy.getBoundingClientRect().width : 0;
    this.textWidth.set(width);
    this.overflowing.set(boxWidth > 0 && width > boxWidth + 1);
  }

  private watchBox(): void {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => this.measure());
    observer.observe(this.host);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  private watchFonts(): void {
    let destroyed = false;
    this.destroyRef.onDestroy(() => destroyed = true);
    // `document.fonts` is missing in old browsers; the text is then measured with whatever font was there.
    document.fonts?.ready.then(() => {
      if (!destroyed) {
        this.measure();
      }
    });
  }

  private watchReducedMotion(): void {
    if (typeof matchMedia !== 'function') {
      return;
    }
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion.set(query.matches);
    if (typeof query.addEventListener === 'function') {
      const onChange = (event: MediaQueryListEvent) => this.reducedMotion.set(event.matches);
      query.addEventListener('change', onChange);
      this.destroyRef.onDestroy(() => query.removeEventListener('change', onChange));
    }
  }
}
