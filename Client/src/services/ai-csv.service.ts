import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom, map, Observable } from 'rxjs';
import { environment } from '../environments/environment';
import { ImageImportModel } from '../models/image-import-model';
import { AIGenerationMode } from '../models/aigeneration-mode';
import { CourseType } from '../models/course-type';

@Injectable({providedIn: 'root'})
export class AiCsvService {
  private readonly endpointUrl = `${environment.apiUrl}/api/csv/generate-from-image`;

  constructor(private readonly httpClient: HttpClient) {
  }

  // Images are optional here: with none, the server asks the AI to work from the lesson's own word list.
  generateCsvFromImagesCreative(imageFiles: File[], imageImportModel: ImageImportModel): Observable<string> {
    const formData = new FormData();
    imageFiles.forEach(file => {
      formData.append('images', file, file.name);
    });

    let params = new HttpParams()
      .set('isCreative', imageImportModel.AIMode === AIGenerationMode.Auto)
      .set('exportType', imageImportModel.exportType!)
      .set('courseType', imageImportModel.courseType!)
      .set('lessonNumber', imageImportModel.lessonNumber!);

    if (imageImportModel.level !== null) {
      params = params.set('level', imageImportModel.level);
    }
    if (imageImportModel.courseType === CourseType.Other && imageImportModel.courseName) {
      params = params.set('courseName', imageImportModel.courseName);
    }

    const response = this.httpClient.post(this.endpointUrl, formData, {
      params,
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
