import { Injectable } from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {environment} from '../environments/environment';

@Injectable({ providedIn: 'root' })
export class AiCsvService {
  private readonly endpointUrl = `${environment.apiUrl}/api/GenerateCsvFromImage`;

  constructor(private readonly httpClient: HttpClient) {
  }
  async generateCsvFromImage(imageFile: File): Promise<string> {
    const formData = new FormData();
    formData.append('image', imageFile, imageFile.name);

    const response = await firstValueFrom(this.httpClient.post(this.endpointUrl, formData, { withCredentials: true, responseType: 'text' }));

    if (!response) {
      throw new Error('Không thể xử lý ảnh từ API.');
    }

    return this.extractCsvContent(response);
  }

  async generateCsvFromImages(imageFiles: File[]): Promise<string> {
    const formData = new FormData();
    imageFiles.forEach(file => {
      formData.append('images', file, file.name);
    });

    const response = await firstValueFrom(this.httpClient.post(this.endpointUrl, formData, { withCredentials: true, responseType: 'text' }));

    if (!response) {
      throw new Error('Không thể xử lý ảnh từ API.');
    }

    return this.extractCsvContent(response);
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
