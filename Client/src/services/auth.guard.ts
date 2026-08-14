import { Injectable, inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';


function hasAccess(authService: AuthService, router: Router) {
  if (authService.isLoggedIn()) {
    return true;
  }
  router.navigate(['/login']);
  return false;
}
@Injectable({
  providedIn: 'root'
})
export class AuthGuard {
  private authService = inject(AuthService);
  private router = inject(Router);

  canActivate(): boolean {
    return hasAccess(this.authService, this.router);
  }
}

export const authGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return hasAccess(authService, router);
};
