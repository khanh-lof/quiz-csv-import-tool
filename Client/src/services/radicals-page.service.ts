import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AiJob } from '../models/ai-job';
import { FileExportService } from './file-export.service';

// The page of a finished "Ghép bộ thủ" job (`GET csv/jobs/{id}/page`): a standalone HTML file that the server
// draws from the exercise the job keeps. Fetched with the token like every job route, then shown in a frame
// or saved as a file.
@Injectable({ providedIn: 'root' })
export class RadicalsPageService {
  constructor(private readonly httpClient: HttpClient,
              private readonly fileExportService: FileExportService) {
  }

  static fileName(title: string): string {
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-') || 'QuizTool';
    return `${safeTitle}-GhepBoThu.html`;
  }

  page(jobId: string): Observable<string> {
    return this.httpClient.get(`/api/csv/jobs/${encodeURIComponent(jobId)}/page`, { responseType: 'text' });
  }

  download(job: AiJob, html: string): void {
    this.fileExportService.downloadBlob(RadicalsPageService.fileName(job.title), new Blob([html], { type: 'text/html;charset=utf-8' }));
  }
}
