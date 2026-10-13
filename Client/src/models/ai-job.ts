import { ExportType } from './export-type';

export type AiJobStatus = 'running' | 'done' | 'failed';

// One AI generation as the server stores it (GET /api/csv/jobs). `csv` is the model's raw answer, empty
// until the job is done; `errorStatus` is the HTTP status a failure used to be answered with (502, 504).
export interface AiJob {
  id: string;
  status: AiJobStatus;
  title: string;
  creative: boolean;
  // Only creative jobs have a platform; sent by ordinal like everywhere else.
  exportType: ExportType | null;
  intelligence: number;
  imageCount: number;
  csv: string;
  errorStatus: number;
  errorMessage: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface AiJobFilter {
  search: string;
  status: AiJobStatus | null;
  creative: boolean | null;
  exportType: ExportType | null;
}

// Lower case with accents dropped, so "ni hao" finds "nǐ hǎo" and "cau hoi" finds "Câu hỏi".
function normalizeForSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();
}

// Keeps the jobs matching every filter that is set. The search looks through the title, the error and the
// generated CSV itself, so a word can be found by the question or answer it appears in.
export function filterJobs(jobs: AiJob[], filter: AiJobFilter): AiJob[] {
  const needle = normalizeForSearch(filter.search.trim());
  return jobs.filter(job =>
    (filter.status === null || job.status === filter.status)
    && (filter.creative === null || job.creative === filter.creative)
    && (filter.exportType === null || job.exportType === filter.exportType)
    && (needle === '' || normalizeForSearch(`${job.title}\n${job.errorMessage}\n${job.csv}`).includes(needle)));
}
