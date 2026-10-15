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
import { NzInputNumberComponent } from 'ng-zorro-antd/input-number';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { NzRadioComponent, NzRadioGroupComponent } from 'ng-zorro-antd/radio';
import { NzSwitchComponent } from 'ng-zorro-antd/switch';
import { DEFAULT_PASS_PERCENT, MAX_PASS_PERCENT, MIN_PASS_PERCENT, passMark, STAGES, stagePosition } from '../../../game/stages';
import { AiJob } from '../../../models/ai-job';
import {
  Assignment,
  assignmentErrorMessage,
  DEFAULT_ATTEMPTS_LIMIT,
  MAX_ATTEMPTS_LIMIT,
  MIN_ATTEMPTS_LIMIT,
  stageCountsOf,
  STAGE_LOCK_LABELS,
  StageLock,
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
const PERCENT_SUFFIX = / ?%$/;

// One stage of the quiz in the "Điểm qua màn" field: its number (the identity), the position shown, its game,
// its questions, the percentage the teacher typed (null while the box is empty) and what that comes to.
interface PassRow {
  stage: number;
  position: number;
  icon: string;
  name: string;
  count: number;
  value: number | null;
  percent: number;
  mark: number;
}

// What a typed percentage means: a whole number from the minimum to the maximum, the default when empty.
function effectivePercent(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return DEFAULT_PASS_PERCENT;
  }
  return Math.min(MAX_PASS_PERCENT, Math.max(MIN_PASS_PERCENT, Math.round(value)));
}

// What a typed replay limit means: a whole number from the minimum to the maximum, the default when empty.
function effectiveAttempts(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return DEFAULT_ATTEMPTS_LIMIT;
  }
  return Math.min(MAX_ATTEMPTS_LIMIT, Math.max(MIN_ATTEMPTS_LIMIT, Math.round(value)));
}

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
    NzInputNumberComponent,
    NzRadioComponent,
    NzRadioGroupComponent,
    NzSwitchComponent,
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
  protected readonly minPercent = MIN_PASS_PERCENT;
  protected readonly maxPercent = MAX_PASS_PERCENT;
  protected readonly defaultPercent = DEFAULT_PASS_PERCENT;
  protected readonly minAttemptsLimit = MIN_ATTEMPTS_LIMIT;
  protected readonly maxAttemptsLimit = MAX_ATTEMPTS_LIMIT;
  protected readonly formatPercent = (value: number | string): string => `${value}%`;
  protected readonly parsePercent = (value: string): number => Number(value.replace(PERCENT_SUFFIX, ''));
  protected readonly timeModes = (Object.keys(TIME_MODE_LABELS) as TimeMode[])
    .map(value => ({value, label: TIME_MODE_LABELS[value]}));

  protected readonly stageLocks = (Object.keys(STAGE_LOCK_LABELS) as StageLock[])
    .map(value => ({value, label: STAGE_LOCK_LABELS[value]}));

  protected readonly label = signal('');
  protected readonly deadline = signal<Date | null>(null);
  protected readonly timeMode = signal<TimeMode>('standard');
  protected readonly stageLock = signal<StageLock>('sequential');
  // The percentage typed for each stage ("1" to "6"); a stage not in it has the default.
  private readonly passInputs = signal<Record<string, number | null>>({});
  // The replay limit per stage: whether the teacher set one, and the number typed (null while the box is
  // empty). It only exists with the `open` stage lock, see `maxAttemptsSent`.
  protected readonly limitAttempts = signal(false);
  protected readonly attemptsInput = signal<number | null>(DEFAULT_ATTEMPTS_LIMIT);
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

  // A row for each stage the quiz has, so the teacher sets the pass mark only of the games students will play.
  protected readonly passRows = computed<PassRow[]>(() => {
    const quiz = this.quiz();
    if (!quiz) {
      return [];
    }
    const inputs = this.passInputs();
    return STAGES.filter(def => (quiz.stages.get(def.stage)?.length ?? 0) > 0).map(def => {
      const count = quiz.stages.get(def.stage)!.length;
      const value = inputs[String(def.stage)] ?? null;
      const percent = effectivePercent(value);
      return {
        stage: def.stage,
        position: stagePosition(quiz.stages.keys(), def.stage),
        icon: def.icon,
        name: def.name,
        count,
        value,
        percent,
        mark: passMark(count, percent),
      };
    });
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

  // An empty box (null) is read as the default when it matters, not rewritten while the teacher types.
  protected setPercent(stage: number, value: number | null): void {
    this.passInputs.update(inputs => ({...inputs, [String(stage)]: value}));
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
      stageLock: this.stageLock(),
      passPercents: this.passPercents(),
      maxAttempts: this.maxAttemptsSent(),
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

  // What goes to the server: the limit when the lock is `open` and the teacher switched it on, else null (no
  // limit, which is all the `sequential` lock allows). An empty or out-of-range box reads as the default or
  // the nearest limit, like the pass percentages.
  protected maxAttemptsSent(): number | null {
    return this.stageLock() === 'open' && this.limitAttempts() ? effectiveAttempts(this.attemptsInput()) : null;
  }

  // The complete map the server wants: the percentage of every stage the quiz has, whole and in range.
  private passPercents(): Record<string, number> {
    const percents: Record<string, number> = {};
    for (const row of this.passRows()) {
      percents[String(row.stage)] = row.percent;
    }
    return percents;
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

  protected showLeaderboard(assignment: Assignment): void {
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
    this.stageLock.set('sequential');
    this.passInputs.set({});
    this.limitAttempts.set(false);
    this.attemptsInput.set(DEFAULT_ATTEMPTS_LIMIT);
    this.error.set('');
    this.assignment.set(null);
  }
}
