import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { NzInputNumberComponent } from 'ng-zorro-antd/input-number';
import { NzOptionComponent, NzSelectComponent } from 'ng-zorro-antd/select';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NzTableModule } from 'ng-zorro-antd/table';
import { NzTagComponent } from 'ng-zorro-antd/tag';
import { NzDropdownModule } from 'ng-zorro-antd/dropdown';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AiJob, AiJobStatus, filterJobs, lessonLabel } from '../../models/ai-job';
import { ExportType } from '../../models/export-type';
import { GESTURE_QUIZ_COLUMNS } from '../../models/gesture-quiz';
import { CourseType } from '../../models/course-type';
import { HskStandard, hskMaxLevel } from '../../models/hsk-standard';
import { AiJobService } from '../../services/ai-job.service';
import { AiCsvService } from '../../services/ai-csv.service';
import { CsvImportService } from '../../services/csv-import.service';
import { PendingImportService } from '../../services/pending-import.service';
import { FileExportService } from '../../services/file-export.service';
import { WaygroundExtensionService } from '../../services/wayground-extension.service';
import { AssignDialog } from '../assignments/assign-dialog/assign-dialog';

const PAGE_SIZE = 10;

// The columns of an Auto job's CSV, which has no header row: the platform's own import layout.
const CREATIVE_COLUMNS: Record<ExportType, string[]> = {
  [ExportType.GimKit]: ['Question', 'Correct Answer', 'Incorrect Answer 1', 'Incorrect Answer 2', 'Incorrect Answer 3'],
  [ExportType.Blooket]: ['Question #', 'Question Text', 'Answer 1', 'Answer 2', 'Answer 3', 'Answer 4', 'Time Limit (sec)', 'Correct Answer(s)'],
  [ExportType.Wayground]: ['Question Text', 'Question Type', 'Option 1', 'Option 2', 'Option 3', 'Option 4', 'Option 5',
    'Correct Answer', 'Time in seconds', 'Image Link', 'Answer explanation'],
  [ExportType.GestureQuiz]: GESTURE_QUIZ_COLUMNS,
};

interface ResultTable {
  headers: string[];
  rows: string[][];
}

// The history of the user's AI generations, kept on the server: the table shows each job's state
// (the page polls while one runs), lets the user search and filter what the AI produced, and hands a
// finished job to the table page or exports it, the way the result used to be handled on completion.
@Component({
  selector: 'app-ai-jobs',
  imports: [
    CommonModule,
    FormsModule,
    NzTableModule,
    NzModalModule,
    NzButtonComponent,
    NzIconDirective,
    NzInputDirective,
    NzInputNumberComponent,
    NzSelectComponent,
    NzOptionComponent,
    NzTagComponent,
    NzDropdownModule,
    NzMenuModule,
    AssignDialog,
  ],
  templateUrl: './ai-jobs.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './ai-jobs.css',
})
export class AiJobs implements OnInit {
  protected readonly pageSize = PAGE_SIZE;
  protected readonly ExportType = ExportType;
  protected readonly CourseType = CourseType;
  protected readonly HskStandard = HskStandard;
  protected readonly lessonLabel = lessonLabel;
  // Lets the filter accept any level a job could have (HSK 3.0 goes to 9).
  protected readonly maxLevel = hskMaxLevel(HskStandard.V3);
  // Publishing needs the extension; without it only the download works.
  protected readonly extensionInstalled: boolean;
  protected readonly platformName = FileExportService.platformName;

  protected readonly search = signal('');
  protected readonly status = signal<AiJobStatus | null>(null);
  protected readonly creative = signal<boolean | null>(null);
  protected readonly exportType = signal<ExportType | null>(null);
  protected readonly courseType = signal<CourseType | null>(null);
  protected readonly hskStandard = signal<HskStandard | null>(null);
  protected readonly level = signal<number | null>(null);
  protected readonly lessonNumber = signal<number | null>(null);
  // The job whose result is shown in the popup. Kept apart from `viewOpen` so the content stays while the popup fades out.
  protected readonly viewing = signal<AiJob | null>(null);
  protected readonly viewOpen = signal(false);
  // The job being given to students in the assign dialog. Kept apart from `assignOpen` for the same reason as `viewing`.
  protected readonly assigning = signal<AiJob | null>(null);
  protected readonly assignOpen = signal(false);
  protected readonly viewTable = computed<ResultTable | null>(() => {
    const job = this.viewing();
    return job && job.status === 'done' ? this.resultTable(job) : null;
  });

  // inject() rather than a constructor parameter: the fields below read the service while being initialized.
  private readonly jobService = inject(AiJobService);
  protected readonly jobs = this.jobService.jobs;
  protected readonly loaded = this.jobService.loaded;
  protected readonly filtered = computed(() => filterJobs(this.jobs(), {
    search: this.search(), status: this.status(), creative: this.creative(), exportType: this.exportType(),
    courseType: this.courseType(), hskStandard: this.hskStandard(), level: this.level(), lessonNumber: this.lessonNumber(),
  }));
  protected readonly isFiltering = computed(() =>
    this.search().trim() !== '' || this.status() !== null || this.creative() !== null || this.exportType() !== null
    || this.courseType() !== null || this.hskStandard() !== null || this.level() !== null || this.lessonNumber() !== null);

  constructor(
    private readonly aiCsvService: AiCsvService,
    private readonly csvImportService: CsvImportService,
    private readonly pendingImportService: PendingImportService,
    private readonly fileExportService: FileExportService,
    private readonly waygroundExtensionService: WaygroundExtensionService,
    private readonly notificationService: NzNotificationService,
    private readonly modalService: NzModalService,
    private readonly router: Router,
  ) {
    this.extensionInstalled = waygroundExtensionService.isInstalled();
  }

  ngOnInit(): void {
    // Shows what the server has, and keeps polling when a job is still running (e.g. after a reload).
    this.jobService.watch();
  }

  protected clearFilters(): void {
    this.search.set('');
    this.status.set(null);
    this.creative.set(null);
    this.exportType.set(null);
    this.courseType.set(null);
    this.hskStandard.set(null);
    this.level.set(null);
    this.lessonNumber.set(null);
  }

  // The HSK standard only means something for HSK, so its filter is hidden (and dropped) for other courses.
  protected setCourseType(courseType: CourseType | null): void {
    this.courseType.set(courseType);
    if (courseType !== CourseType.Hsk) {
      this.hskStandard.set(null);
    }
  }

  protected view(job: AiJob): void {
    this.viewing.set(job);
    this.viewOpen.set(true);
  }

  // The model's answer as the user would import it, without code fences or chatter around it.
  protected resultText(job: AiJob): string {
    return this.aiCsvService.extractCsvContent(job.csv);
  }

  // The result as rows and columns. A Formatted job's CSV carries its own header row; an Auto job's has
  // none, so the columns are named after the platform it was made for.
  private resultTable(job: AiJob): ResultTable {
    const rows = this.csvImportService.parseCsvRows(this.resultText(job)).filter(row => row.some(cell => cell !== ''));
    if (job.creative && job.exportType !== null) {
      const labels = CREATIVE_COLUMNS[job.exportType];
      const width = Math.max(labels.length, ...rows.map(row => row.length));
      return {headers: Array.from({length: width}, (_, i) => labels[i] ?? ''), rows};
    }
    const [headers = [], ...body] = rows;
    return {headers, rows: body};
  }

  protected rowCount(job: AiJob): number {
    const text = this.resultText(job);
    return text ? text.split(/\r?\n/).filter(line => line.trim() !== '').length : 0;
  }

  // A formatted job's rows go to the table page for review, like an import.
  protected openInTable(job: AiJob): void {
    const rows = this.csvImportService.parseCsv(this.resultText(job));
    if (rows.length === 0) {
      this.notificationService.warning('Không có dữ liệu', 'AI không trả về dữ liệu CSV hợp lệ từ các ảnh.', {nzPlacement: 'top'});
      return;
    }
    this.pendingImportService.set(rows);
    this.router.navigateByUrl('/quiz');
  }

  // A gesture quiz is played on QuizTool itself, straight from its job; the page loads the job by id.
  protected play(job: AiJob): void {
    this.router.navigateByUrl('/play/' + job.id);
  }

  // Giving a gesture quiz to students happens in a dialog; it opens at the form each time.
  protected assign(job: AiJob): void {
    this.assigning.set(job);
    this.assignOpen.set(true);
  }

  // A creative job is already a whole quiz: build the platform's file, then download it, or (Wayground
  // only, the user's choice per job) let the extension publish it.
  protected exportJob(job: AiJob, publish: boolean): void {
    const exportType = job.exportType!;
    const exported = this.fileExportService.exportFileFromCsvContent(
      FileExportService.buildFileName(job.title, exportType), this.resultText(job), exportType, !publish);
    if (!exported) {
      this.notificationService.warning('Không có dữ liệu', 'AI không trả về câu hỏi nào. Vui lòng thử lại.', {nzPlacement: 'top'});
      return;
    }
    if (publish && exported.xlsx) {
      this.waygroundExtensionService.sendImport(job.title, exported.fileName, exported.xlsx);
      this.notificationService.info('Đang tạo quiz trên Wayground…',
        'Tiện ích đang publish quiz, xong sẽ báo link chia sẻ ở đây.', {nzPlacement: 'top'});
    } else if (exportType === ExportType.GestureQuiz) {
      // There is nothing to import: the file is played from the Game page.
      this.notificationService.success('Tải xong rồi',
        `Đã tải file ${exported.fileName}, mở nó ở trang Game là chơi được nhaa.`,
        {nzPlacement: 'top'});
    } else {
      this.notificationService.success('Tải xong rồi',
        `Đã tải file ${exported.fileName}, import vào ${FileExportService.platformName(exportType)} là dùng được nhaa.`,
        {nzPlacement: 'top'});
    }
  }

  // A menu item cannot hold a popconfirm (the menu closes under it), so deleting asks in a modal.
  protected confirmRemove(job: AiJob): void {
    this.modalService.confirm({
      nzTitle: 'Xóa mục này?',
      nzContent: job.title,
      nzOkText: 'Xóa',
      nzOkDanger: true,
      nzClassName: 'qt-confirm-danger',
      nzIconType: 'delete',
      nzCancelText: 'Giữ lại',
      nzCentered: true,
      nzOnOk: () => this.remove(job),
    });
  }

  private remove(job: AiJob): void {
    this.jobService.remove(job.id).subscribe({
      error: () => this.notificationService.error('Không xóa được', 'Vui lòng thử lại.', {nzPlacement: 'top'}),
    });
  }

  protected statusLabel(job: AiJob): string {
    switch (job.status) {
      case 'running':
        return 'Đang chạy';
      case 'done':
        return 'Xong';
      default:
        return 'Lỗi';
    }
  }
}
