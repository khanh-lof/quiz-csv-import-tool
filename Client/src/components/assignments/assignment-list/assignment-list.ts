import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { finalize, interval } from 'rxjs';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzCardComponent } from 'ng-zorro-antd/card';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzDropdownModule } from 'ng-zorro-antd/dropdown';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzTableModule } from 'ng-zorro-antd/table';
import { NzTagComponent } from 'ng-zorro-antd/tag';
import {
  Assignment,
  assignmentErrorMessage,
  assignmentStatusText,
  isOpenAt,
  shareUrl,
} from '../../../models/assignment';
import { AssignmentService } from '../../../services/assignment.service';
import { DeadlinePicker } from '../deadline-picker/deadline-picker';
import { ShareLink } from '../share-link/share-link';

const PAGE_SIZE = 10;
// How often "now" moves on, so an assignment whose closing time passes flips to closed without a reload.
const CLOCK_TICK_MS = 30_000;

// "Bài đã giao" (/assignments): the teacher's assignments, with their status and student count, and the
// actions on each.
@Component({
  selector: 'app-assignment-list',
  imports: [
    CommonModule,
    RouterLink,
    NzCardComponent,
    NzTableModule,
    NzModalModule,
    NzButtonComponent,
    NzIconDirective,
    NzTagComponent,
    NzDropdownModule,
    NzMenuModule,
    DeadlinePicker,
    ShareLink,
  ],
  templateUrl: './assignment-list.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './assignment-list.css',
})
export class AssignmentList implements OnInit {
  protected readonly pageSize = PAGE_SIZE;
  protected readonly helpText =
    'Giao bài ở AI › Lịch sử.';
  protected readonly assignments = signal<Assignment[]>([]);
  protected readonly loading = signal(false);
  // False until a list has arrived, so the empty state is not claimed before (or instead of) an answer.
  protected readonly loaded = signal(false);
  protected readonly failed = signal(false);
  protected readonly now = signal(new Date());

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

  protected isOpen(assignment: Assignment): boolean {
    return isOpenAt(assignment, this.now());
  }

  protected statusText(assignment: Assignment): string {
    return assignmentStatusText(assignment, this.now());
  }

  protected async copyLink(assignment: Assignment): Promise<void> {
    try {
      await navigator.clipboard.writeText(shareUrl(assignment.code));
      this.notificationService.success('Đã sao chép link', '', { nzPlacement: 'top' });
    } catch {
      // No clipboard access (an insecure page, or the browser said no): the QR popup shows the link to copy by hand.
      this.notificationService.warning('Chưa sao chép được',
        'Lấy link ở Mã QR.', { nzPlacement: 'top' });
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
      nzTitle: 'Đóng bài?',
      nzContent: 'Học sinh sẽ không vào chơi được nữa.',
      nzOkText: 'Đóng bài',
      nzCancelText: 'Hủy',
      nzCentered: true,
      nzOnOk: () => this.closeAssignment(assignment),
    });
  }

  // that would close at once.
  protected askReopen(assignment: Assignment): void {
    this.reopening.set(assignment);
    this.reopenDeadline.set(null);
    this.reopenOpen.set(true);
  }

  // Reopening asks for a new closing time first: the old one may be past, and the server refuses a reopen

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
      error: err => this.fail('Không mở lại được bài', err),
    });
  }

  protected confirmRemove(assignment: Assignment): void {
    this.modalService.confirm({
      nzTitle: 'Xóa bài này?',
      nzContent: 'Bài và toàn bộ kết quả của học sinh sẽ bị xóa.',
      nzOkText: 'Xóa',
      nzOkDanger: true,
      nzClassName: 'qt-confirm-danger',
      nzIconType: 'delete',
      nzCancelText: 'Giữ lại',
      nzCentered: true,
      nzOnOk: () => this.remove(assignment),
    });
  }

  private closeAssignment(assignment: Assignment): void {
    this.assignmentService.update(assignment.id, { closed: true }).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: updated => this.replace(updated),
      error: err => this.fail('Không đóng được bài', err),
    });
  }

  private remove(assignment: Assignment): void {
    this.assignmentService.remove(assignment.id).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: () => this.assignments.update(list => list.filter(item => item.id !== assignment.id)),
      error: err => this.fail('Không xóa được bài', err),
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

  private fail(title: string, err: unknown): void {
    this.notificationService.error(title, assignmentErrorMessage(err), { nzPlacement: 'top' });
  }
}
