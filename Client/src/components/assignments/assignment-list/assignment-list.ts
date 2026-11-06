import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { finalize, interval } from 'rxjs';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzDropdownModule } from 'ng-zorro-antd/dropdown';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NzOptionComponent, NzSelectComponent } from 'ng-zorro-antd/select';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzTableModule } from 'ng-zorro-antd/table';
import { NzTagComponent } from 'ng-zorro-antd/tag';
import { MessageKey, MessagePipe, Messages } from '../../../i18n/messages';
import {
  Assignment,
  assignmentErrorMessage,
  AssignmentStatusFilter,
  assignmentStatusText,
  filterAssignments,
  isOpenAt,
} from '../../../models/assignment';
import { LANGUAGES, languageTagColor, languageTagText, QuizLanguage } from '../../../models/quiz-language';
import { AssignmentService } from '../../../services/assignment.service';
import { confirmDelete } from '../../../services/confirm-delete';
import { copyShareLink } from '../../../services/copy-share-link';
import { DeadlinePicker } from '../deadline-picker/deadline-picker';
import { ShareLink } from '../share-link/share-link';

const PAGE_SIZE = 10;
// How often "now" moves on, so an assignment whose closing time passes flips to closed without a reload.
const CLOCK_TICK_MS = 30_000;

// "Bài đã giao" (/assignments): the teacher's assignments, with their status and student count, and the
// actions on each.
@Component({
  selector: 'kt-quiz-assignment-list',
  imports: [
    CommonModule,
    FormsModule,
    NzInputDirective,
    NzSelectComponent,
    NzOptionComponent,
    RouterLink,
    NzTableModule,
    NzModalModule,
    NzButtonComponent,
    NzIconDirective,
    NzTagComponent,
    NzDropdownModule,
    NzMenuModule,
    MessagePipe,
    DeadlinePicker,
    ShareLink,
  ],
  templateUrl: './assignment-list.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './assignment-list.css',
})
export class AssignmentList implements OnInit {
  protected readonly pageSize = PAGE_SIZE;
  protected readonly languageColor = languageTagColor;
  protected readonly languageTag = languageTagText;
  protected readonly assignments = signal<Assignment[]>([]);
  protected readonly loading = signal(false);
  // False until a list has arrived, so the empty state is not claimed before (or instead of) an answer.
  protected readonly loaded = signal(false);
  protected readonly failed = signal(false);
  protected readonly now = signal(new Date());

  protected readonly languages = LANGUAGES;
  protected readonly search = signal('');
  protected readonly status = signal<AssignmentStatusFilter | null>(null);
  protected readonly language = signal<QuizLanguage | null>(null);
  protected readonly filtered = computed(() => filterAssignments(this.assignments(), {
    search: this.search(),
    status: this.status(),
    language: this.language(),
  }, this.now()));
  protected readonly isFiltering = computed(() =>
    this.search().trim() !== '' || this.status() !== null || this.language() !== null);

  // The assignment whose QR code is in its popup. Kept apart from `qrOpen` so the content stays while the
  // popup fades out.
  protected readonly qrFor = signal<Assignment | null>(null);
  protected readonly qrOpen = signal(false);

  protected readonly reopening = signal<Assignment | null>(null);
  protected readonly reopenOpen = signal(false);
  protected readonly reopenDeadline = signal<Date | null>(null);
  protected readonly reopenBusy = signal(false);

  private readonly assignmentService = inject(AssignmentService);
  private readonly notificationService = inject(NzNotificationService);
  private readonly messages = inject(Messages);
  private readonly modalService = inject(NzModalService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    interval(CLOCK_TICK_MS).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.now.set(new Date()));
  }

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.assignmentService.list().pipe(
      finalize(() => this.loading.set(false)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: assignments => {
        this.assignments.set(assignments);
        this.loaded.set(true);
        this.failed.set(false);
        this.now.set(new Date());
      },
      error: () => this.failed.set(true),
    });
  }

  protected clearFilters(): void {
    this.search.set('');
    this.status.set(null);
    this.language.set(null);
  }

  protected isOpen(assignment: Assignment): boolean {
    return isOpenAt(assignment, this.now());
  }

  protected statusText(assignment: Assignment): string {
    return assignmentStatusText(assignment, this.now(), this.messages);
  }

  protected async copyLink(assignment: Assignment): Promise<void> {
    if (!await copyShareLink(this.notificationService, this.messages, assignment.code, this.messages.get('assignments.share.fallbackQr'))) {
      this.showQr(assignment);
    }
  }

  protected showQr(assignment: Assignment): void {
    this.qrFor.set(assignment);
    this.qrOpen.set(true);
  }

  // Menu items cannot hold a popconfirm (the menu closes under it), so closing and deleting ask in a modal.
  protected confirmClose(assignment: Assignment): void {
    this.modalService.confirm({
      nzTitle: this.messages.get('assignments.list.closeTitle'),
      nzContent: this.messages.get('assignments.list.closeContent'),
      nzOkText: this.messages.get('assignments.action.closeAssignment'),
      nzCancelText: this.messages.get('common.cancel'),
      nzCentered: true,
      nzOnOk: () => this.closeAssignment(assignment),
    });
  }

  // Reopening asks for a new closing time first: the old one may be past, and the server refuses a reopen
  // that would close at once.
  protected askReopen(assignment: Assignment): void {
    this.reopening.set(assignment);
    this.reopenDeadline.set(null);
    this.reopenOpen.set(true);
  }

  protected reopenDeadlinePassed(): boolean {
    const deadline = this.reopenDeadline();
    return deadline !== null && deadline.getTime() <= Date.now();
  }

  protected confirmReopen(): void {
    const assignment = this.reopening();
    if (!assignment || this.reopenBusy() || this.reopenDeadlinePassed()) {
      return;
    }
    this.reopenBusy.set(true);
    this.assignmentService.update(assignment.id, {
      closed: false,
      closesAt: this.reopenDeadline()?.toISOString() ?? null,
    }).pipe(
      finalize(() => this.reopenBusy.set(false)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: updated => {
        this.replace(updated);
        this.reopenOpen.set(false);
      },
      error: err => this.fail('assignments.failure.reopenAssignment', err),
    });
  }

  protected confirmRemove(assignment: Assignment): void {
    confirmDelete(this.modalService, this.messages, {
      title: this.messages.get('assignments.list.deleteTitle'),
      content: this.messages.get('assignments.list.deleteContent'),
      onOk: () => this.remove(assignment),
    });
  }

  private closeAssignment(assignment: Assignment): void {
    this.assignmentService.update(assignment.id, { closed: true }).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: updated => this.replace(updated),
      error: err => this.fail('assignments.failure.closeAssignment', err),
    });
  }

  private remove(assignment: Assignment): void {
    this.assignmentService.remove(assignment.id).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: () => this.assignments.update(list => list.filter(item => item.id !== assignment.id)),
      error: err => this.fail('assignments.failure.removeAssignment', err),
    });
  }

  // The row takes the server's answer, but keeps the student count it already shows: that is not what an
  // update is about.
  private replace(updated: Assignment): void {
    this.now.set(new Date());
    this.assignments.update(list => list.map(item =>
      item.id === updated.id ? {
        ...updated,
        playerCount: item.playerCount
      } : item));
  }

  private fail(title: MessageKey, err: unknown): void {
    this.notificationService.error(this.messages.get(title), assignmentErrorMessage(err, this.messages));
  }

  protected readonly languageTagText = languageTagText;
}
