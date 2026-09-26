import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams, HttpStatusCode } from '@angular/common/http';
import { map, Observable, retry, throwError, timer } from 'rxjs';
import { AiGenerationRequest } from '../models/ai-generation-request';
import { AIGenerationMode } from '../models/aigeneration-mode';
import { CourseType } from '../models/course-type';

// Called before each retry with its number (1-based), so the UI can say it is retrying.
export type RetryCallback = (retryNumber: number) => void;

// Statuses worth sending the same request again for: the server already retried the LLM gateway's
// quick transient failures within its own deadline, so what reaches us is a whole attempt that ran
// out of time (504, the server's or Vercel's), a gateway failure that outlasted those retries (502),
// the platform being briefly unavailable (503), or no response at all (0). Each retry is a new
// request, so it gets a fresh function time budget; the server gives failed calls back to the rate
// limit, so retrying does not use up the user's quota. Everything else (400, 401, 403 rate limit,
// 413) needs a different request, not the same one again.
const RETRYABLE_STATUSES = new Set<number>([
  0,
  HttpStatusCode.BadGateway,
  HttpStatusCode.ServiceUnavailable,
  HttpStatusCode.GatewayTimeout,
]);
const MAX_RETRIES = 2;
// A timed-out attempt already took most of the server's LLM timeout (~280 s), so only one more.
const MAX_TIMEOUT_RETRIES = 1;
const BASE_RETRY_DELAY_MS = 2000;
const MAX_RETRY_JITTER_MS = 1000;

@Injectable({providedIn: 'root'})
export class AiCsvService {
  private readonly endpointUrl = '/api/csv/generate-from-image';

  constructor(private readonly httpClient: HttpClient) {
  }

  // Images are optional here: with none, the server asks the AI to work from the lesson's own word list.
  generateCsvFromImagesCreative(imageFiles: File[], aiGenerationRequest: AiGenerationRequest, onRetry?: RetryCallback): Observable<string> {
    const formData = new FormData();
    imageFiles.forEach(file => {
      formData.append('images', file, file.name);
    });

    let params = new HttpParams()
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
    if (aiGenerationRequest.courseType === CourseType.Other && aiGenerationRequest.courseName) {
      params = params.set('courseName', aiGenerationRequest.courseName);
    }

    const response = this.httpClient.post(this.endpointUrl, formData, {
      params,
      responseType: 'text'
    });

    if (!response) {
      throw new Error('Không thể tạo câu hỏi từ API.');
    }

    return response.pipe(this.retryTransientFailures(onRetry), map((text: string) => this.extractCsvContent(text)));
  }
  generateCsvFromImages(imageFiles: File[], onRetry?: RetryCallback): Observable<string> {
    const formData = new FormData();
    imageFiles.forEach(file => {
      formData.append('images', file, file.name);
    });

    const response = this.httpClient.post(this.endpointUrl, formData, {
      responseType: 'text'
    });

    if (!response) {
      throw new Error('Không thể xử lý ảnh từ API.');
    }

    return response.pipe(this.retryTransientFailures(onRetry), map((text: string) => this.extractCsvContent(text)));
  }

  // Re-subscribing re-sends the whole request (the FormData body can be sent again) through the
  // interceptors, so a token refreshed meanwhile is picked up too.
  private retryTransientFailures<T>(onRetry?: RetryCallback) {
    let timeoutRetries = 0;
    return retry<T>({
      count: MAX_RETRIES,
      delay: (err: unknown, retryNumber: number) => {
        const status = err instanceof HttpErrorResponse ? err.status : null;
        if (status === null || !RETRYABLE_STATUSES.has(status)) {
          return throwError(() => err);
        }
        if (status === HttpStatusCode.GatewayTimeout && ++timeoutRetries > MAX_TIMEOUT_RETRIES) {
          return throwError(() => err);
        }
        onRetry?.(retryNumber);
        const backoffMs = BASE_RETRY_DELAY_MS * 2 ** (retryNumber - 1);
        return timer(backoffMs + Math.floor(Math.random() * MAX_RETRY_JITTER_MS));
      },
    });
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
