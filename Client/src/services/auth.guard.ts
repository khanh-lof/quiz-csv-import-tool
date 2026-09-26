import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

// Sends an anonymous user to the login screen, which brings them back to the page they asked for.
export const authGuard: CanActivateFn = (route, state) => {
  if (inject(AuthService).hasAccessToken()) {
    return true;
  }
  return inject(Router).createUrlTree(['/login'], {queryParams: {returnUrl: state.url}});
};
