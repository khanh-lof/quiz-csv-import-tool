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
import { ExportType } from '../../../models/export-type';
import { finalize } from 'rxjs';
import { FileExportService } from '../../../services/file-export.service';
import { NzSpinComponent } from 'ng-zorro-antd/spin';

interface ImageItem {
  file: File;
  preview: string;
  isProcessing: boolean;
}
interface ImageImportForm {
  hskLevel: FormControl<number | null>;
  lessonNumber: FormControl<number | null>;
  AIMode: FormControl<AIGenerationMode | null>;
  exportType: FormControl<ExportType | null>;
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
    NzSpinComponent
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
  protected formGroup: FormGroup<ImageImportForm>;
  private requiredIfAIAutoMode: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
    const imageImportForm = control as FormGroup<ImageImportForm>;
    if (imageImportForm.controls.AIMode.value === AIGenerationMode.Auto) {
      const hskLevelValidationErrors = Validators.required(imageImportForm.controls.hskLevel);
      const lessonNumberValidationErrors = Validators.required(imageImportForm.controls.lessonNumber);
      const exportTypeValidationErrors = Validators.required(imageImportForm.controls.exportType);
      if (hskLevelValidationErrors) {
        Utils.addError(imageImportForm.controls.hskLevel, 'required');
      }
      else {
        Utils.removeError(imageImportForm.controls.hskLevel, 'required');
      }
      if (lessonNumberValidationErrors) {
        Utils.addError(imageImportForm.controls.lessonNumber, 'required');
      }
      else {
        Utils.removeError(imageImportForm.controls.lessonNumber, 'required');
      }
      if (exportTypeValidationErrors) {
        Utils.addError(imageImportForm.controls.exportType, 'required');
      }
      else {
        Utils.removeError(imageImportForm.controls.exportType, 'required');
      }
      return null;
    }

    Utils.removeError(imageImportForm.controls.hskLevel, 'required');
    Utils.removeError(imageImportForm.controls.lessonNumber, 'required');
    Utils.removeError(imageImportForm.controls.exportType, 'required');
    return null;
  };

  constructor(
    private readonly modalRef: NzModalRef,
    private readonly aiCsvService: AiCsvService,
    private readonly csvImportService: CsvImportService,
    private readonly fileExportService: FileExportService,
    private readonly notificationService: NzNotificationService,
    private readonly destroyRef: DestroyRef,
    formBuilder: FormBuilder
  ) {
    this.formGroup = formBuilder.group<ImageImportForm>({
      AIMode: formBuilder.control<AIGenerationMode | null>(AIGenerationMode.Auto, Validators.required),
      hskLevel: formBuilder.control<number | null>(null),
      lessonNumber: formBuilder.control<number | null>(null),
      exportType: formBuilder.control<ExportType | null>(null),
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
    if (this.selectedImages.length === 0) {
      this.notificationService.warning('Lỗi', 'Không có ảnh để xử lý.', {nzPlacement: 'top'});
      return;
    }

    this.isProcessingImages = true;
    const imageCount = this.selectedImages.length;

    this.selectedImages.forEach(img => img.isProcessing = true);

    const imageFiles = this.selectedImages.map(img => img.file);
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
        error: err => {
          this.notificationService.error('Lỗi nhập ảnh', err instanceof Error ? err.message : 'Không thể xử lý ảnh.', {nzPlacement: 'top'});
        },
      });
      return;
    }
    this.aiCsvService.generateCsvFromImagesCreative(imageFiles, {
      hskLevel: this.formGroup.controls.hskLevel.value,
        AIMode: this.formGroup.controls.AIMode.value,
        lessonNumber: this.formGroup.controls.lessonNumber.value,
        exportType: this.formGroup.controls.exportType.value,
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
      error: err => {
        this.notificationService.error('Lỗi nhập ảnh', err instanceof Error ? err.message : 'Không thể xử lý ảnh.', {nzPlacement: 'top'});
      },
    });
  }

  protected readonly ExportType = ExportType;
}
