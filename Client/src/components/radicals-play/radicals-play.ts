import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  OnInit,
  signal,
  viewChild
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzSpinComponent } from 'ng-zorro-antd/spin';
import { NzAlertComponent } from 'ng-zorro-antd/alert';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { NzTableModule } from 'ng-zorro-antd/table';
import { NzTagComponent } from 'ng-zorro-antd/tag';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { AiJob } from '../../models/ai-job';
import { ExportType } from '../../models/export-type';
import { hasReviewItems, RadicalsReview, radicalsReviewOf } from '../../models/radicals-review';
import {
  editRowCount,
  flaggedEdit,
  MAX_EDIT_NOTE_LENGTH,
  MAX_EDIT_PINYIN_LENGTH,
  RadicalsEdit,
  radicalsEditError,
  withChar,
  withComponent,
  withWord
} from '../../models/radicals-edit';
import { AiJobService } from '../../services/ai-job.service';
import { RadicalsPageService } from '../../services/radicals-page.service';
import { LeaveCheck } from '../../services/unsaved-changes.guard';

type Screen = 'loading' | 'ready' | 'error';

// One line of the review: what kind of item, and the items themselves.
interface ReviewLine {
  label: string;
  text: string;
}

// The page of a finished "Ghép bộ thủ" job (`/ai-history/radicals/:jobId`): the exercise the server drew, in a
// sandboxed frame (its scripts run without this origin, so they cannot reach the session), with what the
// teacher should check above it and the download of the same file. "Sửa" turns the review into a table of inputs;
// saving it has the server rebuild the exercise, and the frame shows the new one.
@Component({
  selector: 'kt-quiz-radicals-play',
  imports: [RouterLink, FormsModule, NzButtonComponent, NzIconDirective, NzSpinComponent, NzAlertComponent, NzInputDirective,
    NzTableModule, NzTagComponent, NzModalModule],
  templateUrl: './radicals-play.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './radicals-play.css',
})
export class RadicalsPlay implements OnInit, LeaveCheck {
  private readonly route = inject(ActivatedRoute);
  private readonly jobService = inject(AiJobService);
  private readonly pageService = inject(RadicalsPageService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly modalService = inject(NzModalService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly frameBox = viewChild<ElementRef<HTMLElement>>('frameBox');

  protected readonly maxPinyinLength = MAX_EDIT_PINYIN_LENGTH;
  protected readonly maxNoteLength = MAX_EDIT_NOTE_LENGTH;

  protected readonly screen = signal<Screen>('loading');
  protected readonly errorText = signal('');
  protected readonly job = signal<AiJob | null>(null);
  private readonly html = signal('');
  // Trusted on purpose: the page comes from our own server, and the frame's sandbox keeps its scripts apart.
  protected readonly frameContent = computed<SafeHtml>(() => this.sanitizer.bypassSecurityTrustHtml(this.html()));
  private readonly reviewData = computed(() => {
    const job = this.job();
    return job ? radicalsReviewOf(job.csv) : null;
  });
  protected readonly review = computed(() => {
    const review = this.reviewData();
    return review && hasReviewItems(review) ? reviewLines(review) : [];
  });
  // The dictionary's readings of a word's character whose pinyin looks wrong, shown under the word's pinyin.
  protected readonly readingHints = computed(() => {
    const hints = new Map<string, string>();
    for (const warning of this.reviewData()?.pinyinWarnings ?? []) {
      const hint = `${warning.char} đọc ${warning.readings.join(' / ')}`;
      hints.set(warning.word, hints.has(warning.word) ? `${hints.get(warning.word)}; ${hint}` : hint);
    }
    return hints;
  });

  // The table being edited; null while the exercise is only shown.
  protected readonly edit = signal<RadicalsEdit | null>(null);
  protected readonly editLoading = signal(false);
  protected readonly saving = signal(false);
  protected readonly editError = signal('');
  protected readonly saveNotice = signal('');
  // True once the teacher typed into the table, until it is saved or closed.
  private readonly dirty = signal(false);
  protected readonly hasDropped = computed(() => this.edit()?.words.some(row => row.dropped) ?? false);
  protected readonly editEmpty = computed(() => {
    const edit = this.edit();
    return edit !== null && editRowCount(edit) === 0;
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

  canLeave(): boolean | Observable<boolean> {
    if (!this.dirty()) {
      return true;
    }
    return new Observable<boolean>(subscriber => {
      this.confirmDiscard(leave => {
        subscriber.next(leave);
        subscriber.complete();
      });
    });
  }

  @HostListener('window:beforeunload', ['$event'])
  protected warnBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.dirty()) {
      event.preventDefault();
    }
  }

  protected startEdit(): void {
    const job = this.job();
    if (!job || this.editLoading()) {
      return;
    }
    this.editLoading.set(true);
    this.editError.set('');
    this.saveNotice.set('');
    this.pageService.edit(job.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: edit => {
        this.editLoading.set(false);
        this.edit.set(edit);
      },
      error: (err: unknown) => {
        this.editLoading.set(false);
        this.editError.set(radicalsEditError(err, 'Không tải được. Thử lại.'));
      },
    });
  }

  protected cancelEdit(): void {
    if (!this.dirty()) {
      this.closeEdit();
      return;
    }
    this.confirmDiscard(discard => {
      if (discard) {
        this.closeEdit();
      }
    });
  }

  private closeEdit(): void {
    this.edit.set(null);
    this.editError.set('');
    this.dirty.set(false);
  }

  private confirmDiscard(answer: (discard: boolean) => void): void {
    this.modalService.confirm({
      nzTitle: 'Bỏ các thay đổi chưa lưu?',
      nzOkText: 'Bỏ',
      nzOkDanger: true,
      nzCancelText: 'Sửa tiếp',
      nzCentered: true,
      nzOnOk: () => answer(true),
      nzOnCancel: () => answer(false),
    });
  }

  protected setWord(hanzi: string, change: { pinyin?: string; meaning?: string }): void {
    this.edit.update(edit => edit && withWord(edit, hanzi, change));
    this.dirty.set(true);
  }

  protected setChar(char: string, meaning: string): void {
    this.edit.update(edit => edit && withChar(edit, char, meaning));
    this.dirty.set(true);
  }

  protected setComponent(component: string, change: { name?: string; pinyin?: string; meaning?: string }): void {
    this.edit.update(edit => edit && withComponent(edit, component, change));
    this.dirty.set(true);
  }

  protected save(): void {
    const job = this.job();
    const edit = this.edit();
    if (!job || !edit || this.saving()) {
      return;
    }
    this.saving.set(true);
    this.editError.set('');
    this.pageService.revise(job.id, edit).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: revised => {
        this.jobService.replace(revised);
        this.job.set(revised);
        this.reloadPage(revised.id);
      },
      error: (err: unknown) => {
        this.saving.set(false);
        const flagged = flaggedEdit(err);
        if (flagged) {
          this.edit.set(flagged);
          this.editError.set('Sửa các ô đỏ.');
          return;
        }
        this.editError.set(radicalsEditError(err, 'Không lưu được. Thử lại.'));
      },
    });
  }

  // The exercise is saved by now: a page that does not load stays as it was, and the frame says nothing new.
  private reloadPage(jobId: string): void {
    this.pageService.page(jobId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: html => {
        this.saving.set(false);
        this.html.set(html);
        this.closeEdit();
      },
      error: () => {
        this.saving.set(false);
        this.closeEdit();
        this.saveNotice.set('Đã lưu. Tải lại trang để xem bài mới.');
      },
    });
  }

  private open(jobId: string): void {
    this.screen.set('loading');
    this.closeEdit();
    this.saveNotice.set('');
    const known = this.jobService.jobs().find(job => job.id === jobId);
    if (known || this.jobService.loaded()) {
      this.load(known ?? null);
      return;
    }
    // Opened straight from a link or a reload: the history has not been fetched yet.
    this.jobService.refresh().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: jobs => this.load(jobs.find(job => job.id === jobId) ?? null),
      error: () => this.fail('Không tải được. Tải lại trang.'),
    });
  }

  private load(job: AiJob | null): void {
    if (!job || job.exportType !== ExportType.Radicals) {
      this.fail('Không tìm thấy bài này.');
      return;
    }
    if (job.status !== 'done') {
      this.fail(job.status === 'running' ? 'AI chưa tạo xong bài này.' : 'Lần tạo này bị lỗi.');
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
        : 'Không tải được. Tải lại trang.'),
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
      text: `${warning.word}: ${warning.char} ghi "${warning.syllable}", đọc ${warning.readings.join(' / ')}`
    });
  }
  add('Bỏ vì thiếu pinyin', review.droppedWords);
  for (const lesson of review.skippedLessons ?? []) {
    lines.push({ label: `Bài ${lesson.lesson} bị bỏ`, text: `chỉ ${lesson.usableWordCount} từ ghép bộ được` });
  }
  add('Nghĩa chữ do AI điền', review.aiChars);
  add('Bộ do AI điền', review.aiComponents);
  add('Không vẽ được', review.missingGlyphs);
  return lines;
}
