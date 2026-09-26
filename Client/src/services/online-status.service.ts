import { inject, Injectable, NgZone, signal } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, fromEvent } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class OnlineStatusService {
  private router = inject(Router);
  private ngZone = inject(NgZone);

  private readonly onlineSubject = new BehaviorSubject<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  readonly isOnline$ = this.onlineSubject.asObservable();
  readonly isOnline = signal<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  private previousUrl: string = '/';

  constructor() {
    this.initListeners();
  }

  private initListeners(): void {
    if (typeof window === 'undefined') {
      return;
    }

    fromEvent(window, 'online').subscribe(() => {
      this.ngZone.run(() => {
        this.updateStatus(true);
        this.handleOnlineEvent();
      });
    });

    fromEvent(window, 'offline').subscribe(() => {
      this.ngZone.run(() => {
        this.updateStatus(false);
        this.handleOfflineEvent();
      });
    });

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.updateStatus(false);
      this.handleOfflineEvent();
    }
  }

  private updateStatus(online: boolean): void {
    this.onlineSubject.next(online);
    this.isOnline.set(online);
  }

  private handleOfflineEvent(): void {
    const currentUrl = this.router.url;
    if (currentUrl && !currentUrl.includes('/offline')) {
      this.previousUrl = currentUrl;
    }
    this.router.navigate(['/offline']);
  }

  private handleOnlineEvent(): void {
    if (this.router.url.includes('/offline')) {
      this.navigateToReturnUrl();
    }
  }

  navigateToReturnUrl(): void {
    const targetUrl =
      this.previousUrl && this.previousUrl !== '/offline' && this.previousUrl !== '/'
        ? this.previousUrl
        : '/quiz';
    this.router.navigateByUrl(targetUrl);
  }

  async checkConnection(): Promise<boolean> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.updateStatus(false);
      return false;
    }

    try {
      const response = await fetch(`/logo.ico?_t=${Date.now()}`, {
        method: 'HEAD',
        cache: 'no-store'
      });
      const isOnline = response.ok || response.status < 500;
      this.updateStatus(isOnline);
      return isOnline;
    } catch {
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : false;
      this.updateStatus(isOnline);
      return isOnline;
    }
  }
}
