import { Injectable } from '@angular/core';
import { HttpBackend, HttpClient, HttpErrorResponse, HttpParams, HttpStatusCode } from '@angular/common/http';
import { catchError, forkJoin, map, Observable, of, switchMap, throwError } from 'rxjs';
import { AiGenerationRequest } from '../models/ai-generation-request';
import { AIGenerationMode } from '../models/aigeneration-mode';
import { CourseType, courseHasLevels } from '../models/course-type';
import { extractCsvContent } from '../models/csv-text';
import { ExportType } from '../models/export-type';
import { QuizLanguage } from '../models/quiz-language';

// What the server answers when it accepts a generation. The result is not in it: the server keeps
// working on the job after answering, and `AiJobService` follows it.
export interface SubmittedJob {
  id: string;
}

// What the server answers to `POST /api/csv/uploads`: each image is posted to `url` with its `fields`, signed.
export interface UploadGrant {
  url: string;
  uploads: { publicId: string; fields: Record<string, string> }[];
}

/** An image could not be uploaded to the image store. */
export class ImageUploadError extends Error {
}

// Starting a generation only uploads the request. The server retries the LLM gateway's transient
// failures itself while it works on the job, so there is no client-side retry: a failed job is shown
// as failed and the user sends it again ("Tạo lại", `AiJobService.retry`).
@Injectable({ providedIn: 'root' })
export class AiCsvService {
  private readonly endpointUrl = '/api/csv/jobs';
  private readonly uploadsUrl = '/api/csv/uploads';
  // Bypasses the interceptors, so the access token never goes to the image store.
  private readonly imageStoreClient: HttpClient;

  constructor(private readonly httpClient: HttpClient, httpBackend: HttpBackend) {
    this.imageStoreClient = new HttpClient(httpBackend);
  }

  // Images are optional here: with none, the server asks the AI to work from the lesson's own word list.
  // `title` names the job in the history table.
  submitCreative(imageFiles: File[], aiGenerationRequest: AiGenerationRequest, title: string): Observable<SubmittedJob> {
    let params = new HttpParams()
      .set('title', title)
      .set('isCreative', aiGenerationRequest.AIMode === AIGenerationMode.Auto)
      .set('language', aiGenerationRequest.language ?? QuizLanguage.Chinese)
      .set('exportType', aiGenerationRequest.exportType!)
      .set('courseType', aiGenerationRequest.courseType!)
      .set('lessonNumbers', [...aiGenerationRequest.lessonNumbers!].sort((a, b) => a - b).join(','));

    if (aiGenerationRequest.level !== null && courseHasLevels(aiGenerationRequest.courseType)) {
      params = params.set('level', aiGenerationRequest.level);
    }
    if (aiGenerationRequest.courseType === CourseType.Hsk && aiGenerationRequest.hskStandard !== null) {
      params = params.set('hskStandard', aiGenerationRequest.hskStandard);
    }
    if (aiGenerationRequest.courseType === CourseType.Other && aiGenerationRequest.courseName) {
      params = params.set('courseName', aiGenerationRequest.courseName);
    }
    // The server ignores these for the other platforms, so they are not sent for them. Sorted here
    // although the server sorts too, so what is sent never depends on the order the boxes were ticked in.
    if (aiGenerationRequest.exportType === ExportType.GestureQuiz) {
      if (aiGenerationRequest.gestureStages !== null) {
        params = params.set('gestureStages', [...aiGenerationRequest.gestureStages].sort((a, b) => a - b).join(','));
      }
      if (aiGenerationRequest.questionsPerStage !== null) {
        params = params.set('questionsPerStage', aiGenerationRequest.questionsPerStage);
      }
    }

    return this.submit(imageFiles, params);
  }

  submitFormatted(imageFiles: File[], title: string, language: QuizLanguage): Observable<SubmittedJob> {
    return this.submit(imageFiles, new HttpParams().set('title', title).set('language', language));
  }

  extractCsvContent(rawText: string): string {
    return extractCsvContent(rawText);
  }

  private submit(imageFiles: File[], params: HttpParams): Observable<SubmittedJob> {
    return this.buildBody(imageFiles).pipe(
      switchMap(body => this.httpClient.post<SubmittedJob>(this.endpointUrl, body, { params })));
  }

  // The images go straight to the image store, signed by the server, and the job names them. A server without
  // an image store answers 404 to the signing; the images are then sent with the job.
  private buildBody(imageFiles: File[]): Observable<FormData> {
    if (imageFiles.length === 0) {
      return of(new FormData());
    }
    const params = new HttpParams().set('count', imageFiles.length);
    return this.httpClient.post<UploadGrant>(this.uploadsUrl, null, { params }).pipe(
      switchMap(grant => this.uploadAll(imageFiles, grant)),
      map(publicIds => {
        const formData = new FormData();
        publicIds.forEach(id => formData.append('imageId', id));
        return formData;
      }),
      catchError(err => {
        if (err instanceof HttpErrorResponse && err.status === HttpStatusCode.NotFound) {
          return of(this.filesBody(imageFiles));
        }
        return throwError(() => err);
      }),
    );
  }

  private uploadAll(imageFiles: File[], grant: UploadGrant): Observable<string[]> {
    return forkJoin(imageFiles.map((file, i) => {
      const upload = grant.uploads[i];
      const formData = new FormData();
      Object.entries(upload.fields).forEach(([name, value]) => formData.append(name, value));
      formData.append('file', file, file.name);
      return this.imageStoreClient.post(grant.url, formData).pipe(
        map(() => upload.publicId),
        catchError(err => throwError(() => new ImageUploadError(`Uploading ${file.name} failed: ${err?.message ?? err}`))),
      );
    }));
  }

  private filesBody(imageFiles: File[]): FormData {
    const formData = new FormData();
    imageFiles.forEach(file => {
      formData.append('images', file, file.name);
    });
    return formData;
  }

}
