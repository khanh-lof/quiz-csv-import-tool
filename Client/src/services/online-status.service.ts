import { inject, Injectable, NgZone, signal } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, fromEvent } from 'rxjs';

// /play and everything under it (/play/:jobId, a student's /play/s/:code, the teacher's
// /play/preview/:assignmentId), with or without a query string or fragment.
const GESTURE_PLAY_URL = /^\/play(?:[/?#]|$)/;

@Injectable({
  providedIn: 'root'
})
export class OnlineStatusService {
  readonly isOnline = signal<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  private router = inject(Router);
  private ngZone = inject(NgZone);
  private readonly onlineSubject = new BehaviorSubject<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  readonly isOnline$ = this.onlineSubject.asObservable();
  private previousUrl: string = '/';

  constructor() {
    this.initListeners();
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
    // The gesture quiz runs entirely in the browser once its page has loaded (the camera, the models and
    // the questions are all local), so losing the connection mid-game must not throw the player out to the
    // offline screen. The status itself is still updated by the caller.
    if (GESTURE_PLAY_URL.test(currentUrl)) {
      return;
    }
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
}
