import { Component, DestroyRef, inject, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { catchError, filter, map, of } from 'rxjs';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzMenuDirective, NzMenuItemComponent } from 'ng-zorro-antd/menu';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzTooltipDirective } from 'ng-zorro-antd/tooltip';
import { AuthService } from '../../services/auth.service';

// The two ways of building a quiz, as the routes that host them.
type WorkspaceMode = '/quiz' | '/ai';

// Frame shared by the vocabulary table and the AI page: the nav menu (the two modes and the account
// action) and the title. Switching is plain router navigation, so /ai's auth guard sends an anonymous
// user to log in, and a refused navigation simply leaves the current item highlighted.
@Component({
  selector: 'app-workspace',
  imports: [
    RouterOutlet,
    RouterLink,
    NzIconDirective,
    NzMenuDirective,
    NzMenuItemComponent,
    NzTooltipDirective
  ],
  templateUrl: './workspace.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './workspace.css'
})
export class Workspace {
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);
  private readonly notificationService = inject(NzNotificationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);

  protected readonly mode = toSignal(
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      map(() => this.currentMode())
    ),
    {initialValue: this.currentMode()}
  );

  // The router puts a mode's page on screen before its first change detection, which runs a task later.
  // In between the browser can draw the page without its ng-zorro classes (button types, checked radios,
  // input styles), and their `transition: all` then plays every control into its style slowly. Rendering
  // the page right away gives it its full styles before it is ever drawn.
  protected onPageActivate(): void {
    this.cdr.detectChanges();
  }

  private currentMode(): WorkspaceMode {
    return this.router.url.startsWith('/ai') ? '/ai' : '/quiz';
  }

  protected isLoggedIn(): boolean {
    return this.authService.hasAccessToken();
  }

  protected login(): void {
    this.router.navigate(['/login'], {queryParams: {returnUrl: this.router.url}});
  }

  protected logout(): void {
    this.authService.logout().pipe(
      catchError(() => of(null)),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => {
      this.notificationService.success('Đã đăng xuất', 'Hẹn gặp lại nhaa.', {nzPlacement: 'top'});
      // The AI page needs a login, so fall back to the table that works anonymously.
      if (this.currentMode() === '/ai') {
        this.router.navigateByUrl('/quiz');
      }
    });
  }
}
