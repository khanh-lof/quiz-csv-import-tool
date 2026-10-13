import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { NzOptionComponent, NzSelectComponent } from 'ng-zorro-antd/select';
import { NzTableModule } from 'ng-zorro-antd/table';
import { NzTagComponent } from 'ng-zorro-antd/tag';
import { NzPopconfirmDirective } from 'ng-zorro-antd/popconfirm';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AiJob, AiJobStatus, filterJobs } from '../../models/ai-job';
import { ExportType } from '../../models/export-type';
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
  protected readonly platformName = FileExportService.platformName;

  protected readonly search = signal('');
  protected readonly status = signal<AiJobStatus | null>(null);
  protected readonly creative = signal<boolean | null>(null);
  protected readonly exportType = signal<ExportType | null>(null);
  private readonly expanded = signal<ReadonlySet<string>>(new Set());

  // inject() rather than a constructor parameter: the fields below read the service while being initialized.
  private readonly jobService = inject(AiJobService);
  protected readonly jobs = this.jobService.jobs;
  protected readonly loaded = this.jobService.loaded;
  protected readonly filtered = computed(() => filterJobs(this.jobs(), {
    search: this.search(), status: this.status(), creative: this.creative(), exportType: this.exportType(),
  }));
  protected readonly isFiltering = computed(() =>
    this.search().trim() !== '' || this.status() !== null || this.creative() !== null || this.exportType() !== null);

  constructor(
    private readonly aiCsvService: AiCsvService,
    private readonly csvImportService: CsvImportService,
    private readonly pendingImportService: PendingImportService,
    private readonly fileExportService: FileExportService,
    private readonly waygroundExtensionService: WaygroundExtensionService,
    private readonly notificationService: NzNotificationService,
    private readonly router: Router,
  ) {
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

  // "Tải file", or "Publish" when the extension will take a Wayground file; follows the delivery choice
  // on the form above, which is remembered in localStorage.
  protected exportLabel(job: AiJob): string {
    return this.willPublish(job) ? 'Publish Wayground' : 'Tải file';
  }

  private willPublish(job: AiJob): boolean {
    return job.exportType === ExportType.Wayground
      && this.waygroundExtensionService.shouldPublish(this.waygroundExtensionService.preferredDelivery());
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

  // A creative job is already a whole quiz: build the platform's file, then download it or let the extension publish it.
  protected exportJob(job: AiJob): void {
    const exportType = job.exportType!;
    const publish = this.willPublish(job);
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
