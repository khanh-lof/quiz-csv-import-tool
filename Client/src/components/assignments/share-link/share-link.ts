import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, viewChild } from '@angular/core';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzQRCodeComponent } from 'ng-zorro-antd/qr-code';
import { shareUrl } from '../../../models/assignment';

// What a teacher hands to the students: the link of an assignment to copy, its code, and a QR code of the
// link for a phone or a projector. Compact, so it fits in a dialog and on the leaderboard page.
@Component({
  selector: 'app-share-link',
  imports: [NzButtonComponent, NzIconDirective, NzInputDirective, NzQRCodeComponent],
  templateUrl: './share-link.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './share-link.css',
})
export class ShareLink {
  readonly code = input.required<string>();
  readonly qrSize = input(180);

  protected readonly url = computed(() => shareUrl(this.code()));

  private readonly notificationService = inject(NzNotificationService);
  private readonly linkInput = viewChild.required<ElementRef<HTMLInputElement>>('linkInput');

  protected selectLink(): void {
    this.linkInput().nativeElement.select();
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.url());
      this.notificationService.success('Đã sao chép link', 'Gửi link này cho học sinh nhaa.', { nzPlacement: 'top' });
    } catch {
      // No clipboard access (an insecure page, or the browser said no): leave the link selected, ready for Ctrl+C.
      this.selectLink();
      this.notificationService.warning('Chưa sao chép được',
        'Link đã được chọn sẵn, bạn nhấn Ctrl+C để sao chép nhé.', { nzPlacement: 'top' });
    }
  }
}
