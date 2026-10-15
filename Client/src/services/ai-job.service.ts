import { Injectable, signal } from '@angular/core';
import { HttpClient, HttpStatusCode } from '@angular/common/http';
import { catchError, exhaustMap, map, Observable, of, Subscription, takeWhile, tap, timer } from 'rxjs';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AiJob } from '../models/ai-job';
import { AuthService } from './auth.service';

const POLL_INTERVAL_MS = 3000;
// Polling stops after this many answers in a row without a running job, and gives up after this many
// failed ones (offline, logged out) so a forgotten tab does not keep calling the server.
const DEFAULT_IDLE_POLLS = 1;
const MAX_FAILED_POLLS = 10;

// The AI generations of the signed-in user. They run on the server whether or not this page stays
// open, so the table shows what the server has: `watch` polls while a job is running, and a job
// finishing while the app is open is announced wherever the user is.
@Injectable({ providedIn: 'root' })
export class AiJobService {
  readonly jobs = signal<AiJob[]>([]);
  // False until the first answer arrives, so the table can tell "still loading" from "no jobs yet".
  readonly loaded = signal(false);
  private readonly endpointUrl = '/api/csv/jobs';
  private polling: Subscription | null = null;
  private idlePollsToStop = DEFAULT_IDLE_POLLS;
  private idlePolls = 0;
  // Jobs seen running, to recognise the moment one finishes.
  private readonly runningIds = new Set<string>();

  constructor(private readonly http: HttpClient,
              private readonly notificationService: NzNotificationService,
              authService: AuthService) {
    authService.cleared$.subscribe(() => this.reset());
  }

  // The notification renders HTML, and a title is user-chosen text.
  private static escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  }

  // Starts polling if it is not already, and keeps it going for at least `idlePolls` answers without a

  refresh(): Observable<AiJob[]> {
    return this.http.get<{ jobs: AiJob[] }>(this.endpointUrl).pipe(
      map(body => body.jobs),
      tap(jobs => this.apply(jobs)));
  }

  // running job. A just-submitted job passes a larger number: its first poll may come before the job is visible.
  watch(idlePolls = DEFAULT_IDLE_POLLS): void {
    this.idlePollsToStop = Math.max(this.idlePollsToStop, idlePolls);
    this.idlePolls = 0;
    if (this.polling && !this.polling.closed) {
      return;
    }
    let failedPolls = 0;
    this.polling = timer(0, POLL_INTERVAL_MS).pipe(
      exhaustMap(() => this.refresh().pipe(catchError(() => of(null)))),
      takeWhile(jobs => {
        if (jobs === null) {
          return ++failedPolls < MAX_FAILED_POLLS;
        }
        failedPolls = 0;
        this.idlePolls = jobs.some(job => job.status === 'running') ? 0 : this.idlePolls + 1;
        return this.idlePolls < this.idlePollsToStop;
      }),
    ).subscribe({ complete: () => this.idlePollsToStop = DEFAULT_IDLE_POLLS });
  }

  remove(id: string): Observable<void> {
    return this.http.delete<void>(`${this.endpointUrl}/${id}`).pipe(
      tap(() => this.jobs.update(jobs => jobs.filter(job => job.id !== id))),
      catchError(err => {
        // Already gone (another tab deleted it): the table should agree.
        if (err?.status === HttpStatusCode.NotFound) {
          this.jobs.update(jobs => jobs.filter(job => job.id !== id));
          return of(undefined);
        }
        throw err;
      }));
  }

  private apply(jobs: AiJob[]): void {
    for (const job of jobs) {
      if (job.status === 'running') {
        this.runningIds.add(job.id);
      } else if (this.runningIds.delete(job.id)) {
        this.announce(job);
      }
    }
    this.jobs.set(jobs);
    this.loaded.set(true);
  }

  private announce(job: AiJob): void {
    const title = AiJobService.escapeHtml(job.title);
    if (job.status === 'done') {
      this.notificationService.success('AI tạo xong rồi',
        `"${title}" đã xong, lấy kết quả ở bảng lịch sử nhaa.`, { nzPlacement: 'top' });
      return;
    }
    const reason = job.errorStatus === HttpStatusCode.GatewayTimeout
      ? 'AI xử lý quá lâu. Hãy gửi lại hoặc giảm số lượng ảnh.'
      : job.errorStatus === HttpStatusCode.BadGateway
        ? 'AI chưa trả lời được. Hãy gửi lại sau ít phút.'
        : AiJobService.escapeHtml(job.errorMessage || 'Không rõ lỗi.');
    this.notificationService.error('AI tạo không được',
      `"${title}": ${reason} Lượt dùng AI đã được hoàn lại.`, {
        nzPlacement: 'top',
        nzDuration: 0
      });
  }

  private reset(): void {
    this.polling?.unsubscribe();
    this.polling = null;
    this.idlePollsToStop = DEFAULT_IDLE_POLLS;
    this.runningIds.clear();
    this.jobs.set([]);
    this.loaded.set(false);
  }
}
