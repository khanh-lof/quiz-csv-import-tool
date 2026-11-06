import { inject, Injectable, signal, TemplateRef } from '@angular/core';
import { HttpClient, HttpStatusCode } from '@angular/common/http';
import { catchError, exhaustMap, map, Observable, of, Subscription, takeWhile, tap, timer } from 'rxjs';
import { NzNotificationComponent, NzNotificationService } from 'ng-zorro-antd/notification';
import { AiJob, failedJobMessage } from '../models/ai-job';
import { AuthService } from './auth.service';
import { SubmittedJob } from './ai-csv.service';
import { escapeHtml } from './escape-html';
import { Messages } from '../i18n/messages';

export interface HistoryLinkContext {
  $implicit: NzNotificationComponent;
  data: { lead: string };
}

const POLL_INTERVAL_MS = 3000;
// Polling stops after this many answers in a row without a running job, and gives up after this many
// failed ones (offline, logged out) so a forgotten tab does not keep calling the server.
const DEFAULT_IDLE_POLLS = 1;
const MAX_FAILED_POLLS = 10;
// Polls without a running job to wait out after submitting, since the new job may not show up in the first one.
export const NEW_JOB_IDLE_POLLS = 3;

// The AI generations of the signed-in user. They run on the server whether or not this page stays
// open, so the table shows what the server has: `watch` polls while a job is running, and a job
// finishing while the app is open is announced wherever the user is.
@Injectable({ providedIn: 'root' })
export class AiJobService {
  readonly jobs = signal<AiJob[]>([]);
  // False until the first answer arrives, so the table can tell "still loading" from "no jobs yet".
  readonly loaded = signal(false);
  // Set by the app root: notice content that ends with the link to the history page, after `data.lead`.
  readonly historyLinkContent = signal<TemplateRef<HistoryLinkContext> | null>(null);
  private readonly messages = inject(Messages);
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

  refresh(): Observable<AiJob[]> {
    return this.http.get<{ jobs: AiJob[] }>(this.endpointUrl).pipe(
      map(body => body.jobs),
      tap(jobs => this.apply(jobs)));
  }

  // Starts polling if it is not already, and keeps it going for at least `idlePolls` answers without a
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

  // The server's `retryable` is only as fresh as the last poll, so the images' deadline is checked against now.
  canRetry(job: AiJob, now = Date.now()): boolean {
    return job.status === 'failed' && job.retryable && (job.retryUntil === null || Date.parse(job.retryUntil) > now);
  }

  // Sends a failed job again (`POST csv/jobs/{id}/retry`): the server starts a new job with the same request and
  // images and deletes the failed one, which the new one replaces in the table once the next poll shows it.
  retry(job: AiJob): Observable<SubmittedJob> {
    return this.http.post<SubmittedJob>(`${this.endpointUrl}/${job.id}/retry`, null).pipe(
      tap(() => {
        this.jobs.update(jobs => jobs.filter(other => other.id !== job.id));
        this.watch(NEW_JOB_IDLE_POLLS);
      }));
  }

  // Puts a job the server changed in place of the one the list holds, until the next poll brings it anyway.
  replace(job: AiJob): void {
    this.jobs.update(jobs => jobs.map(other => other.id === job.id ? job : other));
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

  notifySent(): void {
    this.notifyWithHistoryLink('info', this.messages.get('ai.job.sentTitle'), this.messages.get('ai.job.sentLead'));
  }

  private notifyWithHistoryLink(type: 'info' | 'success', title: string, lead: string): void {
    const content = this.historyLinkContent();
    this.notificationService[type](title, content ?? `${escapeHtml(lead)} ${this.messages.get('ai.job.historyLink')}`, { nzData: { lead } });
  }

  private announce(job: AiJob): void {
    if (job.status === 'done') {
      this.notifyWithHistoryLink('success', this.messages.get('ai.job.doneTitle'),
        this.messages.get('ai.job.doneLead', { title: job.title }));
      return;
    }
    this.notificationService.error(this.messages.get('ai.job.failedTitle'), this.messages.get('ai.job.failedBody', {
      title: escapeHtml(job.title),
      reason: escapeHtml(failedJobMessage(job, this.messages))
    }), { nzDuration: 0 });
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
