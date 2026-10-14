import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { finalize } from 'rxjs';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { NzRadioComponent, NzRadioGroupComponent } from 'ng-zorro-antd/radio';
import { AiJob } from '../../../models/ai-job';
import {
  Assignment,
  assignmentErrorMessage,
  stageCountsOf,
  TIME_MODE_LABELS,
} from '../../../models/assignment';
import { GestureQuiz, parseGestureQuiz, questionCount } from '../../../models/gesture-quiz';
import { AiCsvService } from '../../../services/ai-csv.service';
import { AssignmentService } from '../../../services/assignment.service';
import { CsvImportService } from '../../../services/csv-import.service';
import { TimeMode } from '../../gesture-play/gesture-settings.service';
import { DeadlinePicker } from '../deadline-picker/deadline-picker';
import { ShareLink } from '../share-link/share-link';

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const MAX_LABEL_LENGTH = 60;

// The dialog that gives a finished Game job to students: label, closing time and time mode, then
// the link, QR code and code of the new assignment. The AI jobs table opens it with `job`; `created` says
// that an assignment now exists.
@Component({
  selector: 'app-assign-dialog',
  imports: [
    FormsModule,
    NzModalModule,
    NzButtonComponent,
    NzIconDirective,
    NzInputDirective,
    NzRadioComponent,
    NzRadioGroupComponent,
    DeadlinePicker,
    ShareLink,
  ],
  templateUrl: './assign-dialog.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './assign-dialog.css',
})
export class AssignDialog {
  readonly job = input<AiJob | null>(null);
  readonly open = model(false);
  readonly created = output<Assignment>();

  protected readonly maxLabelLength = MAX_LABEL_LENGTH;
  protected readonly timeModes = (Object.keys(TIME_MODE_LABELS) as TimeMode[])
    .map(value => ({value, label: TIME_MODE_LABELS[value]}));

  protected readonly label = signal('');
  protected readonly deadline = signal<Date | null>(null);
  protected readonly timeMode = signal<TimeMode>('standard');
  protected readonly sending = signal(false);
  protected readonly error = signal('');
  // The assignment the dialog made: while it is set, the dialog shows its link instead of the form.
  protected readonly assignment = signal<Assignment | null>(null);

  private readonly assignmentService = inject(AssignmentService);
  private readonly aiCsvService = inject(AiCsvService);
  private readonly csvImportService = inject(CsvImportService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  // The job's quiz read the way the game reads it, so the dialog counts and checks what students will play.
  protected readonly quiz = computed<GestureQuiz | null>(() => {
    const job = this.job();
    if (!job) {
      return null;
    }
    const text = this.aiCsvService.extractCsvContent(job.csv);
    const rows = this.csvImportService.parseCsvRows(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
    return parseGestureQuiz(rows, job.title);
  });
  // By id, so a refreshed copy of the same job (the table's polling replaces its objects) does not wipe the form.
  private readonly jobId = computed(() => this.job()?.id ?? null);
  protected readonly questions = computed(() => {
    const quiz = this.quiz();
    return quiz ? questionCount(quiz) : 0;
  });

  constructor() {
    // Opening the dialog, or opening it for another job, starts over with a fresh form: what was typed for
    // the last assignment, or its link, is not what the next one wants.
    effect(() => {
      this.jobId();
      if (this.open()) {
        untracked(() => this.reset());
      }
    });
  }

  // Evaluated on every check rather than cached: a closing time is valid only until it comes.
  protected deadlinePassed(): boolean {
    const deadline = this.deadline();
    return deadline !== null && deadline.getTime() <= Date.now();
  }

  protected canSubmit(): boolean {
    return this.questions() > 0 && !this.sending() && !this.deadlinePassed();
  }

  protected submit(): void {
    const job = this.job();
    const quiz = this.quiz();
    if (!job || !quiz || !this.canSubmit()) {
      return;
    }
    this.sending.set(true);
    this.error.set('');
    this.assignmentService.create({
      jobId: job.id,
      label: this.label().trim(),
      closesAt: this.deadline()?.toISOString() ?? null,
      timeMode: this.timeMode(),
      stageCounts: stageCountsOf(quiz),
    }).pipe(
      finalize(() => this.sending.set(false)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: assignment => {
        this.assignment.set(assignment);
        this.created.emit(assignment);
      },
      error: err => this.error.set(assignmentErrorMessage(err)),
    });
  }

  // The quiz as its owner plays it, which is how it will look to the students (less the saving).
  protected tryJob(): void {
    const job = this.job();
    if (job) {
      window.open('/play/' + encodeURIComponent(job.id), '_blank', 'noopener');
    }
  }

  // The same, from an assignment: its own snapshot and time mode, every stage open, nothing saved.
  protected tryAssignment(assignment: Assignment): void {
    window.open('/play/preview/' + encodeURIComponent(assignment.id), '_blank', 'noopener');
  }

  protected showRanking(assignment: Assignment): void {
    this.router.navigateByUrl('/assignments/' + encodeURIComponent(assignment.id));
    this.close();
  }

  protected close(): void {
    this.open.set(false);
  }

  private reset(): void {
    this.label.set('');
    this.deadline.set(null);
    this.timeMode.set('standard');
    this.error.set('');
    this.assignment.set(null);
  }
}
