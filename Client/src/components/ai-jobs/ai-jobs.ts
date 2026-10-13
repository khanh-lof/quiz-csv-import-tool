import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { NzInputNumberComponent } from 'ng-zorro-antd/input-number';
import { NzOptionComponent, NzSelectComponent } from 'ng-zorro-antd/select';
import { NzTableModule } from 'ng-zorro-antd/table';
import { NzTagComponent } from 'ng-zorro-antd/tag';
import { NzPopconfirmDirective } from 'ng-zorro-antd/popconfirm';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AiJob, AiJobStatus, filterJobs, lessonLabel } from '../../models/ai-job';
import { ExportType } from '../../models/export-type';
import { CourseType } from '../../models/course-type';
import { HskStandard, hskMaxLevel } from '../../models/hsk-standard';
import { AiJobService } from '../../services/ai-job.service';
import { AiCsvService } from '../../services/ai-csv.service';
import { CsvImportService } from '../../services/csv-import.service';
import { PendingImportService } from '../../services/pending-import.service';
import { FileExportService } from '../../services/file-export.service';
import { WaygroundExtensionService } from '../../services/wayground-extension.service';

const PAGE_SIZE = 10;

// The history of the user's AI generations, kept on the server: the table shows each job's state
// (the page polls while one runs), lets the user search and filter what the AI produced, and hands a
// finished job to the table page or exports it, the way the result used to be handled on completion.
@Component({
  selector: 'app-ai-jobs',
  imports: [
    CommonModule,
    FormsModule,
    NzTableModule,
    NzButtonComponent,
    NzIconDirective,
    NzInputDirective,
    NzInputNumberComponent,
    NzSelectComponent,
    NzOptionComponent,
    NzTagComponent,
    NzPopconfirmDirective,
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
  private readonly expanded = signal<ReadonlySet<string>>(new Set());

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

  protected isExpanded(id: string): boolean {
    return this.expanded().has(id);
  }

  protected setExpanded(id: string, expanded: boolean): void {
    this.expanded.update(ids => {
      const next = new Set(ids);
      if (expanded) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  // The model's answer as the user would import it, without code fences or chatter around it.
  protected resultText(job: AiJob): string {
    return this.aiCsvService.extractCsvContent(job.csv);
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
    } else {
      this.notificationService.success('Tải xong rồi',
        `Đã tải file ${exported.fileName}, import vào ${FileExportService.platformName(exportType)} là dùng được nhaa.`,
        {nzPlacement: 'top'});
    }
  }

  protected remove(job: AiJob): void {
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
