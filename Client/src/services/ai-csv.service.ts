import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, map, Observable } from 'rxjs';
import { environment } from '../environments/environment';
import { ImageImportModel } from '../models/image-import-model';
import { AIGenerationMode } from '../models/aigeneration-mode';

@Injectable({providedIn: 'root'})
export class AiCsvService {
  private readonly endpointUrl = `${environment.apiUrl}/api/csv/generate-from-image`;

  constructor(private readonly httpClient: HttpClient) {
  }

  generateCsvFromImagesCreative(imageFiles: File[], imageImportModel: ImageImportModel): Observable<string> {
    const formData = new FormData();
    imageFiles.forEach(file => {
      formData.append('images', file, file.name);
    });

    const response = this.httpClient.post(`${this.endpointUrl}?hskLevel=${imageImportModel.hskLevel}&lessonNumber=${imageImportModel.lessonNumber}&exportType=${imageImportModel.exportType}&isCreative=${(imageImportModel.AIMode === AIGenerationMode.Auto)}`, formData, {
      withCredentials: true,
      responseType: 'text'
    });

    if (!response) {
      throw new Error('Không thể xử lý ảnh từ API.');
    }

    return response.pipe(map((text: string) => this.extractCsvContent(text)));
  }
  generateCsvFromImages(imageFiles: File[]): Observable<string> {
    const formData = new FormData();
    imageFiles.forEach(file => {
      formData.append('images', file, file.name);
    });

    const response = this.httpClient.post(this.endpointUrl, formData, {
      withCredentials: true,
      responseType: 'text'
    });

    if (!response) {
      throw new Error('Không thể xử lý ảnh từ API.');
    }

    return response.pipe(map((text: string) => this.extractCsvContent(text)));
  }

  extractCsvContent(rawText: string): string {
    const trimmed = (rawText || '').trim();
    if (!trimmed) {
      return '';
    }

    const fenced = trimmed.match(/```(?:csv)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return fenced[1].trim();
    }

    const headerMatch = trimmed.match(/(?:^|\n)(Câu hỏi\s*,\s*Đáp án[\s\S]*)/i);
    if (headerMatch?.[1]) {
      return headerMatch[1].trim();
    }

    return trimmed;
  }

}
