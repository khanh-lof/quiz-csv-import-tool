import { Component, DestroyRef, EventEmitter, HostListener, Output, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzModalRef } from 'ng-zorro-antd/modal';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AiCsvService } from '../../../services/ai-csv.service';
import { CsvImportService } from '../../../services/csv-import.service';

import { QuestionDefinition } from '../../../models/question-definition';
import { NzInputNumberComponent } from 'ng-zorro-antd/input-number';
import {
  AbstractControl,
  FormBuilder, FormControl,
  FormGroup,
  FormsModule, ReactiveFormsModule,
  ValidationErrors,
  ValidatorFn,
  Validators
} from '@angular/forms';
import { NzRadioComponent, NzRadioGroupComponent } from 'ng-zorro-antd/radio';
import { AIGenerationMode } from '../../../models/aigeneration-mode';
import { Utils } from '../../../utils';
import { AiGenerationRequest } from '../../../models/ai-generation-request';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NzOptionComponent, NzSelectComponent } from 'ng-zorro-antd/select';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { ExportType } from '../../../models/export-type';
import { CourseType } from '../../../models/course-type';
import { finalize } from 'rxjs';
import { FileExportService } from '../../../services/file-export.service';
import { NzSpinComponent } from 'ng-zorro-antd/spin';
import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { ImageCompressionService, UploadTooLargeError } from '../../../services/image-compression.service';

interface ImageItem {
  file: File;
  preview: string;
}
// The popup's choices, remembered between openings so a teacher going lesson by lesson does not
// re-enter the course, level and platform every time.
const SETTINGS_STORAGE_KEY = 'ai-generation-settings';

interface AiGenerationForm {
  courseType: FormControl<CourseType | null>;
  courseName: FormControl<string | null>;
  level: FormControl<number | null>;
  lessonNumber: FormControl<number | null>;
  AIMode: FormControl<AIGenerationMode | null>;
  exportType: FormControl<ExportType | null>;
  intelligence: FormControl<number | null>;
}

@Component({
  selector: 'app-ai-generation-popup',
  imports: [
    CommonModule,
    NzButtonComponent,
    NzIconDirective,
    FormsModule,
    NzRadioGroupComponent,
    NzRadioComponent,
    NzInputNumberComponent,
    ReactiveFormsModule,
    NzOptionComponent,
    NzSelectComponent,
    NzInputDirective,
    NzSpinComponent
  ],
  templateUrl: './ai-generation-popup.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './ai-generation-popup.css'
})
export class AiGenerationPopup {
  @Output() readonly importedRows = new EventEmitter<QuestionDefinition[]>();
  // The access token expired and could not be refreshed; the host sends the user to log in again.
  @Output() readonly sessionExpired = new EventEmitter<void>();

  // Signals, not plain fields: the ng-zorro modal host is OnPush, so a field changed from an async
  // callback (FileReader, HTTP) would not re-render until the next user event in the popup.
  protected readonly selectedImages = signal<ImageItem[]>([]);
  protected isDragOver = false;
  protected readonly isGenerating = signal(false);
  // Which automatic retry of the AI request is running; 0 while on the first attempt.
  protected readonly retryNumber = signal(0);
  // Seconds since the generation started, shown on the overlay so a minutes-long wait visibly progresses.
  protected readonly elapsedSeconds = signal(0);
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onRetry = (retryNumber: number) => this.retryNumber.set(retryNumber);
  protected dragEnterCounter = 0;

  protected readonly AIGenerationMode = AIGenerationMode;
  protected formGroup: FormGroup<AiGenerationForm>;
  private requiredIfAIAutoMode: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
    const aiGenerationForm = control as FormGroup<AiGenerationForm>;
    const isAutoMode = aiGenerationForm.controls.AIMode.value === AIGenerationMode.Auto;
    const courseType = aiGenerationForm.controls.courseType.value;

    this.setRequired(aiGenerationForm.controls.exportType, isAutoMode);
    this.setRequired(aiGenerationForm.controls.courseType, isAutoMode);
    this.setRequired(aiGenerationForm.controls.lessonNumber, isAutoMode);
    // HSK and YCT always have a level; a course typed in by hand may not, so there the level is optional.
    this.setRequired(aiGenerationForm.controls.level, isAutoMode && courseType !== null && courseType !== CourseType.Other);
    this.setRequired(aiGenerationForm.controls.courseName, isAutoMode && courseType === CourseType.Other);
    return null;
  };

  private setRequired(control: AbstractControl, isRequired: boolean): void {
    if (isRequired && Validators.required(control)) {
      Utils.addError(control, 'required');
    }
    else {
      Utils.removeError(control, 'required');
    }
  }

  constructor(
    private readonly modalRef: NzModalRef,
    private readonly aiCsvService: AiCsvService,
    private readonly csvImportService: CsvImportService,
    private readonly fileExportService: FileExportService,
    private readonly imageCompressionService: ImageCompressionService,
    private readonly notificationService: NzNotificationService,
    private readonly destroyRef: DestroyRef,
    formBuilder: FormBuilder
  ) {
    this.formGroup = formBuilder.group<AiGenerationForm>({
      AIMode: formBuilder.control<AIGenerationMode | null>(AIGenerationMode.Auto, Validators.required),
      courseType: formBuilder.control<CourseType | null>(null),
      courseName: formBuilder.control<string | null>(null),
      level: formBuilder.control<number | null>(null),
      lessonNumber: formBuilder.control<number | null>(null),
      exportType: formBuilder.control<ExportType | null>(null),
      intelligence: formBuilder.control<number | null>(1),
    },{
      validators : [this.requiredIfAIAutoMode]
    })
    this.restoreSettings();
    this.destroyRef.onDestroy(() => this.stopElapsedTimer());
  }

  private restoreSettings(): void {
    try {
      const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (saved) {
        this.formGroup.patchValue(JSON.parse(saved));
      }
    } catch {
      // Storage unavailable or corrupted: start from the defaults.
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.formGroup.getRawValue()));
    } catch {
      // Remembering the settings is only a convenience.
    }
  }

  // While a generation runs (it can take minutes) the popup cannot be dismissed, since closing it
  // would silently cancel the request.
  private setGenerating(isGenerating: boolean): void {
    this.isGenerating.set(isGenerating);
    this.modalRef.updateConfig({nzClosable: !isGenerating, nzMaskClosable: !isGenerating, nzKeyboard: !isGenerating});
    this.stopElapsedTimer();
    if (isGenerating) {
      this.elapsedSeconds.set(0);
      this.elapsedTimer = setInterval(() => this.elapsedSeconds.update(seconds => seconds + 1), 1000);
    }
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer !== null) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }

  closePopup(): void {
    this.modalRef.close();
  }

  onDropZoneEnter(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragEnterCounter++;
    this.isDragOver = true;
  }

  onDropZoneDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  onDropZoneDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragEnterCounter--;
    if (this.dragEnterCounter <= 0) {
      this.isDragOver = false;
      this.dragEnterCounter = 0;
    }
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
    this.dragEnterCounter = 0;
    if (this.isGenerating()) {
      return;
    }

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    this.processImageFiles(Array.from(files));
  }

  // Listens on the whole document so Ctrl+V works as soon as the popup is open, without clicking the
  // drop zone first. Only a paste carrying images is taken over; pasting text into a field still works.
  @HostListener('document:paste', ['$event'])
  onPaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (!items || this.isGenerating()) {
      return;
    }

    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          pastedFiles.push(file);
        }
      }
    }

    if (pastedFiles.length > 0) {
      event.preventDefault();
      this.processImageFiles(pastedFiles);
    }
  }

  importFromImage(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;

    if (!files || files.length === 0) {
      return;
    }

    this.processImageFiles(Array.from(files));
    input.value = '';
  }

  private processImageFiles(files: File[]): void {
    const validFiles = files.filter(file => {
      if (!file.type.startsWith('image/')) {
        this.notificationService.error('File không hợp lệ', `${file.name} không phải là ảnh.`, {nzPlacement: 'top'});
        return false;
      }
      const duplicate = this.selectedImages().some(
        x => x.file.name === file.name &&
          x.file.size === file.size &&
          x.file.lastModified === file.lastModified
      );
      if (duplicate) {
        this.notificationService.error('File trùng lặp', `${file.name} đã được thêm trước đó.`, {nzPlacement: 'top'});
        return false;
      }
      return true;
    });

    if (validFiles.length === 0) {
      return;
    }

    validFiles.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        this.selectedImages.update(images => [...images, {
          file: file,
          preview: reader.result as string
        }]);
      };
      reader.readAsDataURL(file);
    });
  }

  removeImage(index: number): void {
    this.selectedImages.update(images => images.filter((_, i) => i !== index));
  }

  clearAllImages(): void {
    this.selectedImages.set([]);
  }

  async generate(): Promise<void> {
    this.formGroup.markAllAsDirty();
    this.formGroup.updateValueAndValidity();
    if (this.formGroup.invalid) {
      this.notificationService.error('Tập trung vàoooo', 'Nhập đủ thông tin ei', {nzPlacement: 'top'});
      return;
    }
    // Only the formatted mode needs images: the creative mode can work from the lesson identifiers alone.
    if (this.selectedImages().length === 0 && this.formGroup.controls.AIMode.value === AIGenerationMode.Formatted) {
      this.notificationService.warning('Thiếu ảnh', 'Chế độ này cần ít nhất 1 ảnh bài học.', {nzPlacement: 'top'});
      return;
    }

    this.saveSettings();
    this.setGenerating(true);
    this.retryNumber.set(0);

    let imageFiles: File[];
    try {
      imageFiles = await this.imageCompressionService.compressForUpload(this.selectedImages().map(img => img.file));
    } catch (err) {
      this.setGenerating(false);
      this.showGenerationError(err);
      return;
    }
    if (this.formGroup.controls.AIMode.value === AIGenerationMode.Formatted) {
      this.aiCsvService.generateCsvFromImages(imageFiles, this.onRetry).pipe(takeUntilDestroyed(this.destroyRef),
        finalize(() => this.setGenerating(false))).subscribe({
        next: csvContent => {
          const rows = this.csvImportService.parseCsv(csvContent);

          if (rows.length === 0) {
            this.notificationService.warning('Không có dữ liệu', 'AI không trả về dữ liệu CSV hợp lệ từ các ảnh.', {nzPlacement: 'top'});
            return;
          }

          this.importedRows.emit(rows);
          this.clearAllImages();
          this.closePopup();
        },
        error: err => this.showGenerationError(err),
      });
      return;
    }
    this.aiCsvService.generateCsvFromImagesCreative(imageFiles, {
      courseType: this.formGroup.controls.courseType.value,
        courseName: this.formGroup.controls.courseName.value,
        level: this.formGroup.controls.level.value,
        AIMode: this.formGroup.controls.AIMode.value,
        lessonNumber: this.formGroup.controls.lessonNumber.value,
        exportType: this.formGroup.controls.exportType.value,
        intelligence: this.formGroup.controls.intelligence.value,
    } satisfies AiGenerationRequest, this.onRetry).pipe(takeUntilDestroyed(this.destroyRef),
      finalize(() => this.setGenerating(false))).subscribe({
      next: csvContent => {
        const exportType = this.formGroup.controls.exportType.value!;
        const fileName = this.fileExportService.exportFileFromCsvContent(
          FileExportService.buildFileName(this.lessonLabel(), exportType), csvContent, exportType);
        if (!fileName) {
          this.notificationService.warning('Không có dữ liệu', 'AI không trả về câu hỏi nào. Vui lòng thử lại.', {nzPlacement: 'top'});
          return;
        }
        this.notificationService.success('Tạo xong rồi',
          `Đã tải file ${fileName}, import vào ${FileExportService.platformName(exportType)} là dùng được nhaa.`,
          {nzPlacement: 'top'});

        this.clearAllImages();
        this.closePopup();
      },
      error: err => this.showGenerationError(err),
    });
  }

  // A too-large upload (our own check, or the platform's 413) and an AI timeout (the server's 504, or
  // the platform stopping the function) are both fixed by sending fewer images, so say so; they stay
  // on screen until closed. Timeouts and gateway failures only get here once AiCsvService's automatic
  // retries have run out.
  // Names the lesson for the download, e.g. "HSK3-Bai5", or "Boya-Bai2" for a course typed in by hand.
  private lessonLabel(): string {
    const {courseType, courseName, level, lessonNumber} = this.formGroup.getRawValue();
    const course = courseType === CourseType.Hsk ? 'HSK'
      : courseType === CourseType.Yct ? 'YCT'
      : (courseName ?? '');
    return `${course}${level ?? ''}-Bai${lessonNumber ?? ''}`;
  }

  private showGenerationError(err: unknown): void {
    const status = err instanceof HttpErrorResponse ? err.status : null;
    const serverMessage = err instanceof HttpErrorResponse && typeof err.error === 'string' ? err.error.trim() : '';
    if (status === HttpStatusCode.Unauthorized) {
      this.notificationService.warning('Hết phiên đăng nhập', 'Vui lòng đăng nhập lại để tiếp tục tạo câu hỏi.', {nzPlacement: 'top'});
      this.sessionExpired.emit();
      this.closePopup();
      return;
    }
    if (status === HttpStatusCode.Forbidden) {
      // The server answers 403 both for the per-user AI rate limit (with a message) and for a role
      // that may not use AI (empty body).
      if (serverMessage) {
        this.notificationService.warning('Hết lượt dùng AI',
          'Bạn đã dùng hết lượt tạo câu hỏi bằng AI cho lúc này. Vui lòng thử lại sau ít phút.',
          {nzPlacement: 'top', nzDuration: 0});
      } else {
        this.notificationService.error('Không có quyền', 'Tài khoản của bạn chưa được cấp quyền dùng AI.', {nzPlacement: 'top'});
      }
      return;
    }
    if (status === 0) {
      this.notificationService.error('Mất kết nối',
        'Không thể kết nối đến máy chủ. Vui lòng kiểm tra mạng rồi thử lại.', {nzPlacement: 'top'});
      return;
    }
    if (status === HttpStatusCode.BadGateway) {
      this.notificationService.error('AI đang gặp sự cố', 'AI chưa trả lời được. Vui lòng thử lại sau ít phút.', {nzPlacement: 'top'});
      return;
    }
    if (status === HttpStatusCode.BadRequest && serverMessage) {
      this.notificationService.error('Yêu cầu không hợp lệ', serverMessage, {nzPlacement: 'top'});
      return;
    }
    if (err instanceof UploadTooLargeError || status === HttpStatusCode.PayloadTooLarge) {
      this.notificationService.error('Ảnh quá lớn',
        'Tổng dung lượng ảnh vượt quá giới hạn tải lên. Vui lòng giảm số lượng ảnh rồi thử lại.',
        {nzPlacement: 'top', nzDuration: 0});
      return;
    }
    if (status === HttpStatusCode.GatewayTimeout) {
      this.notificationService.error('Quá thời gian xử lý',
        'AI xử lý quá lâu. Vui lòng thử lại hoặc giảm số lượng ảnh.',
        {nzPlacement: 'top', nzDuration: 0});
      return;
    }
    this.notificationService.error('Lỗi tạo câu hỏi', err instanceof Error ? err.message : 'Không thể tạo câu hỏi.', {nzPlacement: 'top'});
  }

  protected get generatingStatus(): string {
    return this.retryNumber() > 0 ? `AI đang thử lại (lần ${this.retryNumber()})...` : 'AI đang tạo câu hỏi...';
  }

  protected get elapsedLabel(): string {
    const seconds = this.elapsedSeconds();
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  protected get submitButtonLabel(): string {
    if (this.isGenerating()) {
      return this.retryNumber() > 0 ? `Đang thử lại (lần ${this.retryNumber()})...` : 'Đang xử lý...';
    }
    return this.selectedImages().length > 0
      ? `Tạo câu hỏi (${this.selectedImages().length} ảnh)`
      : 'Tạo câu hỏi';
  }

  protected readonly ExportType = ExportType;
  protected readonly CourseType = CourseType;
}
