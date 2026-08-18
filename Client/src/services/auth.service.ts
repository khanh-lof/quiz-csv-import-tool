import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { tap } from 'rxjs';
import { environment } from '../environments/environment';

@Injectable({providedIn: 'root'})
export class AuthService {
  private accessToken: string | null = null;

  constructor(private http: HttpClient) {
  }
  setAccessToken(token: string) {
    this.accessToken = token;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  clear() {
    this.accessToken = null;
  }

  hasAccessToken(): boolean {
    return !!this.accessToken;
  }
  private baseUrl = `${environment.apiUrl}/api/auth`;

  login(username: string, password: string) {
    return this.http.post<any>(
      `${this.baseUrl}/login`,
      {username, password},
      {withCredentials: true}
    ).pipe(
      tap((res: any) => {
        this.setNewAccessToken(res);
      })
    );
  }

  private setNewAccessToken(res: any) {
    if (res && res.accessToken) {
      this.setAccessToken(res.accessToken);
    }
  }

  refreshToken() {
    return this.http.post<any>(
      `${this.baseUrl}/refresh`,
      {},
      {withCredentials: true}
    ).pipe(
      tap((res: any) => {
        this.setNewAccessToken(res);
      })
    );
  }
}
