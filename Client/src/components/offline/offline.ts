import { Component, DestroyRef, inject, OnInit } from '@angular/core';

import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCardModule } from 'ng-zorro-antd/card';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { OnlineStatusService } from '../../services/online-status.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

@Component({
  selector: 'app-offline',
  standalone: true,
  imports: [
    NzButtonModule,
    NzCardModule,
    NzIconDirective
],
  templateUrl: './offline.html',
  styleUrl: './offline.css'
})
export class OfflineComponent implements OnInit {
  protected readonly onlineStatusService = inject(OnlineStatusService);
  private readonly router = inject(Router);
  private readonly notificationService = inject(NzNotificationService);
  private readonly destroyRef = inject(DestroyRef);

  isChecking = false;

  ngOnInit(): void {
    this.onlineStatusService.isOnline$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((isOnline) => {
        if (isOnline && this.router.url.includes('/offline')) {
          this.notificationService.success('Đã có kết nối', 'Kết nối Internet đã được phục hồi.', {
            nzPlacement: 'top'
          });
          this.onlineStatusService.navigateToReturnUrl();
        }
      });
  }

  async onRetry(): Promise<void> {
    this.isChecking = true;
    try {
      const isOnline = await this.onlineStatusService.checkConnection();
      if (isOnline) {
        this.notificationService.success('Đã có kết nối', 'Kết nối Internet đã được phục hồi.', {
          nzPlacement: 'top'
        });
        this.onlineStatusService.navigateToReturnUrl();
      } else {
        this.notificationService.warning(
          'Chưa có kết nối',
          'Vẫn chưa thể kết nối Internet. Vui lòng kiểm tra lại Wi-Fi hoặc dữ liệu di động.',
          { nzPlacement: 'top' }
        );
      }
    } finally {
      this.isChecking = false;
    }
  }

  onGoHome(): void {
    this.router.navigate(['/']);
  }
}
