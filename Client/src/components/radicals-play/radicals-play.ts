import { ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, OnInit, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzSpinComponent } from 'ng-zorro-antd/spin';
import { NzAlertComponent } from 'ng-zorro-antd/alert';
import { AiJob } from '../../models/ai-job';
import { ExportType } from '../../models/export-type';
import { hasReviewItems, RadicalsReview, radicalsReviewOf } from '../../models/radicals-options';
import { AiJobService } from '../../services/ai-job.service';
import { RadicalsPageService } from '../../services/radicals-page.service';

type Screen = 'loading' | 'ready' | 'error';

// One line of the review: what kind of item, and the items themselves.
interface ReviewLine {
  label: string;
  text: string;
}

// The page of a finished "Ghép bộ thủ" job (`/ai-history/radicals/:jobId`): the exercise the server drew, in a
// sandboxed frame (its scripts run without this origin, so they cannot reach the session), with what the
// teacher should check above it and the download of the same file.
@Component({
  selector: 'app-radicals-play',
  imports: [RouterLink, NzButtonComponent, NzIconDirective, NzSpinComponent, NzAlertComponent],
  templateUrl: './radicals-play.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './radicals-play.css',
})
export class RadicalsPlay implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly jobService = inject(AiJobService);
  private readonly pageService = inject(RadicalsPageService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroyRef = inject(DestroyRef);

  private readonly frameBox = viewChild<ElementRef<HTMLElement>>('frameBox');

  protected readonly screen = signal<Screen>('loading');
  protected readonly errorText = signal('');
  protected readonly job = signal<AiJob | null>(null);
  private readonly html = signal('');
  // Trusted on purpose: the page comes from our own server, and the frame's sandbox keeps its scripts apart.
  protected readonly frameContent = computed<SafeHtml>(() => this.sanitizer.bypassSecurityTrustHtml(this.html()));
  protected readonly review = computed(() => {
    const job = this.job();
    const review = job ? radicalsReviewOf(job.csv) : null;
    return review && hasReviewItems(review) ? reviewLines(review) : [];
  });

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => this.open(params.get('jobId') ?? ''));
  }

  protected download(): void {
    const job = this.job();
    if (job && this.html()) {
      this.pageService.download(job, this.html());
    }
  }

  protected fullScreen(): void {
    void this.frameBox()?.nativeElement.requestFullscreen?.().catch(() => undefined);
  }

  private open(jobId: string): void {
    this.screen.set('loading');
    const known = this.jobService.jobs().find(job => job.id === jobId);
    if (known || this.jobService.loaded()) {
      this.load(known ?? null);
      return;
    }
    // Opened straight from a link or a reload: the history has not been fetched yet.
    this.jobService.refresh().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: jobs => this.load(jobs.find(job => job.id === jobId) ?? null),
      error: () => this.fail('Không tải được. Thử lại.'),
    });
  }

  private load(job: AiJob | null): void {
    if (!job || job.exportType !== ExportType.Radicals) {
      this.fail('Không tìm thấy bài này.');
      return;
    }
    if (job.status !== 'done') {
      this.fail(job.status === 'running' ? 'AI đang tạo bài, chờ một chút.' : 'Bài này tạo lỗi.');
      return;
    }
    this.job.set(job);
    this.pageService.page(job.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: html => {
        this.html.set(html);
        this.screen.set('ready');
      },
      error: (err: unknown) => this.fail(err instanceof HttpErrorResponse && err.status === HttpStatusCode.NotFound
        ? 'Không tìm thấy bài này.'
        : 'Không tải được. Thử lại.'),
    });
  }

  private fail(text: string): void {
    this.errorText.set(text);
    this.screen.set('error');
  }
}

// The review in the teacher's words, one line per kind of item, empty kinds left out.
export function reviewLines(review: RadicalsReview): ReviewLine[] {
  const lines: ReviewLine[] = [];
  const add = (label: string, items: string[] | null | undefined) => {
    if (items && items.length > 0) {
      lines.push({ label, text: items.join(', ') });
    }
  };
  add('AI không chắc', review.uncertainWords);
  add('Pinyin, nghĩa do AI điền', review.aiWords);
  for (const warning of review.pinyinWarnings ?? []) {
    lines.push({
      label: `Pinyin cần xem (bài ${warning.lesson})`,
      text: `${warning.word}: chữ ${warning.char} ghi "${warning.syllable}", chữ này đọc ${warning.readings.join(' / ')}`
    });
  }
  add('Bỏ vì thiếu pinyin', review.droppedWords);
  for (const lesson of review.skippedLessons ?? []) {
    lines.push({ label: `Bài ${lesson.lesson} bị bỏ`, text: `chỉ ${lesson.usableWordCount} từ ghép bộ được` });
  }
  add('Nghĩa chữ do AI viết', review.aiChars);
  add('Bộ do AI mô tả', review.aiComponents);
  add('Không vẽ được', review.missingGlyphs);
  return lines;
}
