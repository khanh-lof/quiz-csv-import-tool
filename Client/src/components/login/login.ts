import { ChangeDetectionStrategy, Component, DestroyRef, inject, OnInit } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';

import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { NzFormModule } from 'ng-zorro-antd/form';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCardModule } from 'ng-zorro-antd/card';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { AuthService } from '../../services/auth.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { Messages, MessagePipe } from '../../i18n/messages';

@Component({
  selector: 'kt-quiz-login',
  standalone: true,
  imports: [
    NgOptimizedImage,
    FormsModule,
    ReactiveFormsModule,
    NzFormModule,
    NzInputModule,
    NzButtonModule,
    NzCardModule,
    NzCheckboxModule,
    NzSpinModule,
    NzIconModule,
    RouterLink,
    MessagePipe
  ],
  templateUrl: './login.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './login.css'
})
export class LoginComponent implements OnInit {
  loginForm!: FormGroup;
  isLoading = false;
  rememberMe = false;
  private readonly authService = inject(AuthService);
  private router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly notificationService = inject(NzNotificationService);
  private readonly messages = inject(Messages);

  // Where to go after logging in, e.g. back to the table with the AI popup reopened. Only an in-app path
  // is accepted ("/…" but not "//…"), so the query param cannot send the user to another site.
  private get returnUrl(): string {
    const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
    return returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//') ? returnUrl : '/quiz';
  }

  ngOnInit() {
    this.initializeForm();
    this.loadRememberedUsername();
    if (this.authService.hasAccessToken()) {
      this.router.navigateByUrl(this.returnUrl);
    }
  }

  onLogin() {
    if (this.loginForm.invalid) {
      return;
    }

    this.isLoading = true;
    const {
      username,
      password
    } = this.loginForm.value;

    this.authService.login(username, password).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: (response) => {
        if (this.rememberMe) {
          localStorage.setItem('remembered_username', username);
        } else {
          localStorage.removeItem('remembered_username');
        }
        this.isLoading = false;
        this.router.navigateByUrl(this.returnUrl);
      },
      error: (error) => {
        this.isLoading = false;
        let errorMessage = this.messages.get('common.tryAgain');
        if (error.status === 401) {
          errorMessage = this.messages.get('app.login.wrongCredentials');
        } else if (error.status === 429) {
          const minutes = Math.ceil(Number(error.headers?.get('Retry-After') ?? 60) / 60);
          errorMessage = this.messages.get('app.login.tooManyAttempts', { minutes });
        } else if (error.status === 0) {
          errorMessage = this.messages.get('common.checkNetwork');
        }
        this.notificationService.error(this.messages.get('app.login.failed'), errorMessage);
      }
    });
  }

  private initializeForm() {
    this.loginForm = this.fb.group({
      username: ['', [Validators.required]],
      password: ['', [Validators.required]]
    });
  }

  private loadRememberedUsername() {
    const rememberedUsername = localStorage.getItem('remembered_username');
    if (rememberedUsername) {
      this.loginForm.patchValue({ username: rememberedUsername });
      this.rememberMe = true;
    }
  }
}
