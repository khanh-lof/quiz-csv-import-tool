import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection
} from '@angular/core';
import { provideRouter, withRouterConfig } from '@angular/router';

import { routes } from './app.routes';
import { provideNzI18n } from 'ng-zorro-antd/i18n';
import { appLocale } from '../i18n/app-locale';
import { registerLocaleData } from '@angular/common';
import vi from '@angular/common/locales/vi';
import { HTTP_INTERCEPTORS, provideHttpClient, withInterceptorsFromDi, withXhr } from '@angular/common/http';
import { AuthInterceptor } from '../services/auth.interceptor';
import { finalize, firstValueFrom, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { AuthService } from '../services/auth.service';
import { provideNzConfig } from 'ng-zorro-antd/core/config';
import { provideNzDateFnsAdapter } from 'ng-zorro-antd/core/time';


registerLocaleData(vi);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideAnimationsAsync(),
    // A navigation refused by a guard (the "Ghép bộ thủ" edits) after the browser's Back has already moved the
    // URL must move the browser back to the entry it left, not overwrite the entry Back landed on.
    provideRouter(routes, withRouterConfig({ canceledNavigationResolution: 'computed' })),
    provideNzI18n(appLocale),
    provideNzConfig({ notification: { nzPlacement: 'top' } }),
    provideHttpClient(withXhr(), withInterceptorsFromDi()),
    provideAppInitializer(() =>
      firstValueFrom(inject(AuthService)
        .refreshToken()
        .pipe(
          catchError(() => of(void 0)),
          finalize(() => {
            document.getElementById('app-loader')?.remove();
          })
        ))
    ),
    {
      provide: HTTP_INTERCEPTORS,
      useClass: AuthInterceptor,
      multi: true
    }, provideNzDateFnsAdapter()
  ]
};
