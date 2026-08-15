import { Component, EventEmitter, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzModalRef } from 'ng-zorro-antd/modal';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AiCsvService } from '../../../services/ai-csv.service';
import { CsvImportService } from '../../../services/csv-import.service';
import { QuestionDefinition } from '../vocabulary-table';

interface ImageItem {
  file: File;
  preview: string;
  isProcessing: boolean;
}

@Component({
  selector: 'app-image-import-popup',
  imports: [
    CommonModule,
    NzButtonComponent,
    NzIconDirective
  ],
  templateUrl: './image-import-popup.component.html',
  styleUrl: './image-import-popup.component.css'
})
export class ImageImportPopupComponent {
  @Output() readonly importedRows = new EventEmitter<QuestionDefinition[]>();

  protected selectedImages: ImageItem[] = [];
  protected isDragOver = false;
  protected isProcessingImages = false;
  protected dragEnterCounter = 0;

  constructor(
    private readonly modalRef: NzModalRef,
    private readonly aiCsvService: AiCsvService,
    private readonly csvImportService: CsvImportService,
    private readonly notificationService: NzNotificationService,
  ) {
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
    if (this.selectedImages.length === 0) {
      this.notificationService.warning('Lỗi', 'Không có ảnh để xử lý.', {nzPlacement: 'top'});
      return;
    }

    this.isProcessingImages = true;
    const imageCount = this.selectedImages.length;

    try {
      this.selectedImages.forEach(img => img.isProcessing = true);

      const imageFiles = this.selectedImages.map(img => img.file);
      const csvContent = await this.aiCsvService.generateCsvFromImages(imageFiles);
      const rows = this.csvImportService.parseCsv(csvContent);

      if (rows.length === 0) {
        this.notificationService.warning('Không có dữ liệu', 'AI không trả về dữ liệu CSV hợp lệ từ các ảnh.', {nzPlacement: 'top'});
        return;
      }

      this.importedRows.emit(rows);
      this.clearAllImages();
      this.closePopup();
    } catch (error) {
      this.notificationService.error('Lỗi nhập ảnh', error instanceof Error ? error.message : 'Không thể xử lý ảnh.', {nzPlacement: 'top'});
    } finally {
      this.isProcessingImages = false;
    }
  }
}
