import { Component, DestroyRef, inject, ChangeDetectionStrategy } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, filter, of } from 'rxjs';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzRadioComponent, NzRadioGroupComponent } from 'ng-zorro-antd/radio';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzTooltipDirective } from 'ng-zorro-antd/tooltip';
import { AuthService } from '../../services/auth.service';

// The two ways of building a quiz, as the routes that host them.
type WorkspaceMode = '/quiz' | '/ai';

// Frame shared by the vocabulary table and the AI page: the account bar, the title and the switch
// between the two. Switching is plain navigation, so /ai's auth guard sends an anonymous user to log in.
@Component({
  selector: 'app-workspace',
  imports: [
    RouterOutlet,
    ReactiveFormsModule,
    NzButtonComponent,
    NzIconDirective,
    NzRadioGroupComponent,
    NzRadioComponent,
    NzTooltipDirective
  ],
  templateUrl: './workspace.html',
  host: {'[class.fit-viewport]': "mode.value === '/quiz'"},
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './workspace.css'
})
export class Workspace {
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);
  private readonly notificationService = inject(NzNotificationService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly mode = new FormControl<WorkspaceMode>(this.currentMode(), {nonNullable: true});

  constructor() {
    this.mode.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(mode => this.switchMode(mode));
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => this.showCurrentMode());
  }

  private showCurrentMode(): void {
    this.mode.setValue(this.currentMode(), {emitEvent: false});
  }

  private currentMode(): WorkspaceMode {
    return this.router.url.startsWith('/ai') ? '/ai' : '/quiz';
  }

  private switchMode(mode: WorkspaceMode): void {
    // A refused navigation (e.g. leaving the AI page mid-generation) puts the radio back on the page shown.
    this.router.navigateByUrl(mode).then(navigated => {
      if (!navigated) {
        this.showCurrentMode();
      }
    });
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
