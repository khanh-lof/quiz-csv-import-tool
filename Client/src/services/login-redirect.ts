import { Location } from '@angular/common';
import { Router } from '@angular/router';

const RETURN_BY_BACK = 'returnByBack';

// Opens the login page from the page it should return to. The history entry is marked so that logging in can go
// back to that page's own entry instead of pushing a second copy of it, which would make Back seem to do nothing.
export function goToLogin(router: Router): void {
  router.navigate(['/login'], {
    queryParams: { returnUrl: router.url },
    state: { [RETURN_BY_BACK]: true }
  });
}

export function opensFromReturnPage(location: Location): boolean {
  const state: unknown = location.getState();
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[RETURN_BY_BACK] === true;
}
