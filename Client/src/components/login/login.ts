import {Component, DestroyRef, inject, OnInit, ChangeDetectionStrategy} from '@angular/core';

import {FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators} from '@angular/forms';
import {Router} from '@angular/router';
import {NzFormModule} from 'ng-zorro-antd/form';
import {NzInputModule} from 'ng-zorro-antd/input';
import {NzButtonModule} from 'ng-zorro-antd/button';
import {NzCardModule} from 'ng-zorro-antd/card';
import {NzCheckboxModule} from 'ng-zorro-antd/checkbox';
import {NzSpinModule} from 'ng-zorro-antd/spin';
import {AuthService} from '../../services/auth.service';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {NzNotificationService} from 'ng-zorro-antd/notification';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [
    FormsModule,
    ReactiveFormsModule,
    NzFormModule,
    NzInputModule,
    NzButtonModule,
    NzCardModule,
    NzCheckboxModule,
    NzSpinModule
],
  templateUrl: './login.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './login.css'
})
export class LoginComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private router = inject(Router);
  private fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly notificationService = inject(NzNotificationService);

  loginForm!: FormGroup;
  isLoading = false;
  rememberMe = false;

  ngOnInit() {
    this.initializeForm();
    this.loadRememberedUsername();
    if (this.authService.hasAccessToken()) {
      this.router.navigate(['/']);
    }
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
      this.loginForm.patchValue({username: rememberedUsername});
      this.rememberMe = true;
    }
  }

  onLogin() {
    if (this.loginForm.invalid) {
      return;
    }

    this.isLoading = true;
    const {username, password} = this.loginForm.value;

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
        this.router.navigate(['/quiz']);
      },
      error: (error) => {
        this.isLoading = false;
        let errorMessage = 'Vui lòng thử lại.';
        if (error.status === 401) {
          errorMessage = 'Sai username hoặc password.';
        } else if (error.status === 0) {
          errorMessage = 'Không thể kết nối đến máy chủ. Vui lòng kiểm tra kết nối của bạn.';
        }
        this.notificationService.error('Đăng nhập thất bại', errorMessage, {nzPlacement: 'top'});
      }
    });
  }
}
