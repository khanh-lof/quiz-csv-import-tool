import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection
} from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { en_US, provideNzI18n } from 'ng-zorro-antd/i18n';
import { registerLocaleData } from '@angular/common';
import en from '@angular/common/locales/en';
import { HTTP_INTERCEPTORS, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { AuthInterceptor } from '../services/auth.interceptor';
import { finalize, firstValueFrom, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { AuthService } from '../services/auth.service';

registerLocaleData(en);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({eventCoalescing: true}),
    provideAnimationsAsync(),
    provideRouter(routes),
    provideNzI18n(en_US),
    provideHttpClient(withInterceptorsFromDi()),
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
    }
  ]
};
