import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { finalize, tap } from 'rxjs';

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
  private baseUrl = '/api/auth';

  login(username: string, password: string) {
    return this.http.post<any>(
      `${this.baseUrl}/login`,
      {username, password}
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

  // Revokes this device's refresh cookie on the server; the local token is dropped whatever the outcome,
  // so the user is logged out here even when the server cannot be reached.
  logout() {
    return this.http.post(`${this.baseUrl}/logout`, {}, {responseType: 'text'}).pipe(
      finalize(() => this.clear())
    );
  }

  refreshToken() {
    return this.http.post<any>(
      `${this.baseUrl}/refresh`,
      {}
    ).pipe(
      tap((res: any) => {
        this.setNewAccessToken(res);
      })
    );
  }
}
