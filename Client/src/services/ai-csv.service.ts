import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AiGenerationRequest } from '../models/ai-generation-request';
import { AIGenerationMode } from '../models/aigeneration-mode';
import { CourseType } from '../models/course-type';

// What the server answers when it accepts a generation. The result is not in it: the server keeps
// working on the job after answering, and `AiJobService` follows it.
export interface SubmittedJob {
  id: string;
}

// Starting a generation only uploads the request. The server retries the LLM gateway's transient
// failures itself while it works on the job, so there is no client-side retry: a failed job is shown
// as failed and the user submits again.
@Injectable({providedIn: 'root'})
export class AiCsvService {
  private readonly endpointUrl = '/api/csv/jobs';

  constructor(private readonly httpClient: HttpClient) {
  }

  // Images are optional here: with none, the server asks the AI to work from the lesson's own word list.
  // `title` names the job in the history table.
  submitCreative(imageFiles: File[], aiGenerationRequest: AiGenerationRequest, title: string): Observable<SubmittedJob> {
    let params = new HttpParams()
      .set('title', title)
      .set('isCreative', aiGenerationRequest.AIMode === AIGenerationMode.Auto)
      .set('exportType', aiGenerationRequest.exportType!)
      .set('courseType', aiGenerationRequest.courseType!)
      .set('lessonNumber', aiGenerationRequest.lessonNumber!);

    if (aiGenerationRequest.level !== null) {
      params = params.set('level', aiGenerationRequest.level);
    }
    if (aiGenerationRequest.intelligence !== null) {
      params = params.set('intelligence', aiGenerationRequest.intelligence);
    }
    if (aiGenerationRequest.courseType === CourseType.Hsk && aiGenerationRequest.hskStandard !== null) {
      params = params.set('hskStandard', aiGenerationRequest.hskStandard);
    }
    if (aiGenerationRequest.courseType === CourseType.Other && aiGenerationRequest.courseName) {
      params = params.set('courseName', aiGenerationRequest.courseName);
    }

    return this.httpClient.post<SubmittedJob>(this.endpointUrl, this.buildBody(imageFiles), {params});
  }

  submitFormatted(imageFiles: File[], title: string): Observable<SubmittedJob> {
    return this.httpClient.post<SubmittedJob>(this.endpointUrl, this.buildBody(imageFiles),
      {params: new HttpParams().set('title', title)});
  }

  private buildBody(imageFiles: File[]): FormData {
    const formData = new FormData();
    imageFiles.forEach(file => {
      formData.append('images', file, file.name);
    });
    return formData;
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
