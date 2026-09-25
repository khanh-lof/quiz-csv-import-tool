import { Component, DestroyRef, EventEmitter, Output, signal, ChangeDetectionStrategy } from '@angular/core';
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
import { ImageImportModel } from '../../../models/image-import-model';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NzOptionComponent, NzSelectComponent } from 'ng-zorro-antd/select';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { ExportType } from '../../../models/export-type';
import { CourseType } from '../../../models/course-type';
import { finalize } from 'rxjs';
import { FileExportService } from '../../../services/file-export.service';
import { NzSpinComponent } from 'ng-zorro-antd/spin';
import { NzSegmentedComponent, NzSegmentedOptions } from 'ng-zorro-antd/segmented';
import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { ImageCompressionService, UploadTooLargeError } from '../../../services/image-compression.service';

interface ImageItem {
  file: File;
  preview: string;
  isProcessing: boolean;
}
interface ImageImportForm {
  courseType: FormControl<CourseType | null>;
  courseName: FormControl<string | null>;
  level: FormControl<number | null>;
  lessonNumber: FormControl<number | null>;
  AIMode: FormControl<AIGenerationMode | null>;
  exportType: FormControl<ExportType | null>;
  intelligence: FormControl<number | null>;
}

@Component({
  selector: 'app-image-import-popup',
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
    NzSpinComponent,
    NzSegmentedComponent
  ],
  templateUrl: './image-import-popup.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './image-import-popup.css'
})
export class ImageImportPopup {
  @Output() readonly importedRows = new EventEmitter<QuestionDefinition[]>();

  protected selectedImages: ImageItem[] = [];
  protected isDragOver = false;
  protected isProcessingImages = false;
  protected dragEnterCounter = 0;

  protected readonly AIGenerationMode = AIGenerationMode;
  // Values are the server's intelligence levels: 1 = LLM_INTELLIGENCE_MODELS[0], 2 = [1].
  protected readonly intelligenceOptions: NzSegmentedOptions = [
    {label: 'Thấp', value: 1},
    {label: 'Cao', value: 2},
  ];
  protected formGroup: FormGroup<ImageImportForm>;
  private requiredIfAIAutoMode: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
    const imageImportForm = control as FormGroup<ImageImportForm>;
    const isAutoMode = imageImportForm.controls.AIMode.value === AIGenerationMode.Auto;
    const courseType = imageImportForm.controls.courseType.value;

    this.setRequired(imageImportForm.controls.exportType, isAutoMode);
    this.setRequired(imageImportForm.controls.courseType, isAutoMode);
    this.setRequired(imageImportForm.controls.lessonNumber, isAutoMode);
    // HSK and YCT always have a level; a course typed in by hand may not, so there the level is optional.
    this.setRequired(imageImportForm.controls.level, isAutoMode && courseType !== null && courseType !== CourseType.Other);
    this.setRequired(imageImportForm.controls.courseName, isAutoMode && courseType === CourseType.Other);
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
    this.formGroup = formBuilder.group<ImageImportForm>({
      AIMode: formBuilder.control<AIGenerationMode | null>(AIGenerationMode.Auto, Validators.required),
      courseType: formBuilder.control<CourseType | null>(CourseType.Hsk),
      courseName: formBuilder.control<string | null>(null),
      level: formBuilder.control<number | null>(null),
      lessonNumber: formBuilder.control<number | null>(null),
      exportType: formBuilder.control<ExportType | null>(null),
      intelligence: formBuilder.control<number | null>(1),
    },{
      validators : [this.requiredIfAIAutoMode]
    })
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

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    this.processImageFiles(Array.from(files));
  }

  onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const items = event.clipboardData?.items;
    if (!items) {
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
      const duplicate = this.selectedImages.some(
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
        this.selectedImages.push({
          file: file,
          preview: reader.result as string,
          isProcessing: false
        });
      };
      reader.readAsDataURL(file);
    });
  }

  removeImage(index: number): void {
    this.selectedImages.splice(index, 1);
  }

  clearAllImages(): void {
    this.selectedImages = [];
  }

  async submitAllImages(): Promise<void> {
    this.formGroup.markAllAsDirty();
    this.formGroup.updateValueAndValidity();
    if (this.formGroup.invalid) {
      this.notificationService.error('Tập trung vàoooo', 'Nhập đủ thông tin ei', {nzPlacement: 'top'});
      return;
    }
    // Only the formatted mode needs images: the creative mode can work from the lesson identifiers alone.
    if (this.selectedImages.length === 0 && this.formGroup.controls.AIMode.value === AIGenerationMode.Formatted) {
      this.notificationService.warning('Lỗi', 'Không có ảnh để xử lý.', {nzPlacement: 'top'});
      return;
    }

    this.isProcessingImages = true;
    const imageCount = this.selectedImages.length;

    this.selectedImages.forEach(img => img.isProcessing = true);

    let imageFiles: File[];
    try {
      imageFiles = await this.imageCompressionService.compressForUpload(this.selectedImages.map(img => img.file));
    } catch (err) {
      this.isProcessingImages = false;
      this.selectedImages.forEach(img => img.isProcessing = false);
      this.showGenerationError(err);
      return;
    }
    if (this.formGroup.controls.AIMode.value === AIGenerationMode.Formatted) {
      this.aiCsvService.generateCsvFromImages(imageFiles).pipe(takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.isProcessingImages = false;
          this.selectedImages.forEach(img => img.isProcessing = false);
        })).subscribe({
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
    } satisfies ImageImportModel).pipe(takeUntilDestroyed(this.destroyRef),
      finalize(() => {
        this.isProcessingImages = false;
        this.selectedImages.forEach(img => img.isProcessing = false);
      })).subscribe({
      next: csvContent => {
        this.fileExportService.exportFileFromCsvContent('NhapFileName.csv', csvContent, this.formGroup.controls.exportType.value!);

        this.clearAllImages();
        this.closePopup();
      },
      error: err => this.showGenerationError(err),
    });
  }

  // A too-large upload (our own check, or the platform's 413) and an AI timeout (the server's 504, or
  // the platform stopping the function) are both fixed by sending fewer images, so say so; they stay
  // on screen until closed.
  private showGenerationError(err: unknown): void {
    const status = err instanceof HttpErrorResponse ? err.status : null;
    if (err instanceof UploadTooLargeError || status === HttpStatusCode.PayloadTooLarge) {
      this.notificationService.error('Ảnh quá lớn',
        'Tổng dung lượng ảnh vượt quá giới hạn tải lên. Vui lòng giảm số lượng ảnh rồi thử lại.',
        {nzPlacement: 'top', nzDuration: 0});
      return;
    }
    if (status === HttpStatusCode.GatewayTimeout) {
      this.notificationService.error('Quá thời gian xử lý',
        'AI xử lý quá lâu. Vui lòng giảm số lượng ảnh hoặc thử lại.',
        {nzPlacement: 'top', nzDuration: 0});
      return;
    }
    this.notificationService.error('Lỗi nhập ảnh', err instanceof Error ? err.message : 'Không thể xử lý ảnh.', {nzPlacement: 'top'});
  }

  protected get submitButtonLabel(): string {
    if (this.isProcessingImages) {
      return 'Đang xử lý...';
    }
    return this.selectedImages.length > 0
      ? `Xử lý tất cả (${this.selectedImages.length})`
      : 'Tạo câu hỏi';
  }

  protected readonly ExportType = ExportType;
  protected readonly CourseType = CourseType;
}
