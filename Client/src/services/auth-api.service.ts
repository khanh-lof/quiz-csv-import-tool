import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { AuthService } from './auth.service';
import { tap } from 'rxjs';
import { environment } from '../environments/environment';

@Injectable({providedIn: 'root'})
export class AuthApiService {
  private baseUrl = `${environment.apiUrl}/api/auth`;

  constructor(private http: HttpClient, private auth: AuthService) {
  }

  login(username: string, password: string) {
    return this.http.post<any>(
      `${this.baseUrl}/login`,
      {username, password},
      {withCredentials: true}
    ).pipe(
      tap((res: any) => {
        this.setAccessToken(res);
      })
    );
  }

  private setAccessToken(res: any) {
    if (res && res.accessToken) {
      this.auth.setAccessToken(res.accessToken);
    }
  }

  refreshToken() {
    return this.http.post<any>(
      `${this.baseUrl}/refresh`,
      {},
      {withCredentials: true}
    ).pipe(
      tap((res: any) => {
        this.setAccessToken(res);
      })
    );
  }
}
