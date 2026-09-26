import { Component, input, ChangeDetectionStrategy } from '@angular/core';
import { NzCollapseComponent, NzCollapsePanelComponent } from 'ng-zorro-antd/collapse';

const STORAGE_KEY_PREFIX = 'usage-guide-collapsed:';

// A collapsible "how to use this page" box, open on a first visit. Once the user closes it, it stays
// closed on this browser (per page, by `storageKey`), so returning users are not in its way.
@Component({
  selector: 'app-usage-guide',
  imports: [NzCollapseComponent, NzCollapsePanelComponent],
  templateUrl: './usage-guide.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './usage-guide.css'
})
export class UsageGuide {
  readonly storageKey = input.required<string>();

  protected get isOpen(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY_PREFIX + this.storageKey()) === null;
    } catch {
      return true;
    }
  }

  protected onOpenChange(open: boolean): void {
    try {
      if (open) {
        localStorage.removeItem(STORAGE_KEY_PREFIX + this.storageKey());
      } else {
        localStorage.setItem(STORAGE_KEY_PREFIX + this.storageKey(), '1');
      }
    } catch {
      // Storage unavailable (e.g. private mode): the guide just opens again next time.
    }
  }
}
