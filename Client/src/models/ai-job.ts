import { ExportType } from './export-type';
import { CourseType } from './course-type';
import { HskStandard } from './hsk-standard';
import { formatLessonNumbers } from './lesson-numbers';
import { QuizLanguage } from './quiz-language';

export type AiJobStatus = 'running' | 'done' | 'failed';

// One AI generation as the server stores it (GET /api/csv/jobs). `csv` is the model's raw answer, empty
// until the job is done; `errorStatus` is the HTTP status a failure used to be answered with (502, 504), and
// `errorCode` why it failed (see `failedJobMessage`), empty on jobs from before the server kept it.
export interface AiJob {
  id: string;
  status: AiJobStatus;
  title: string;
  creative: boolean;
  // Every job has one, Chinese on the jobs from before English.
  language: QuizLanguage;
  // Only creative jobs have a platform; sent by ordinal like everywhere else.
  exportType: ExportType | null;
  intelligence: number;
  imageCount: number;
  // The lessons a creative job was asked for, ascending. Null on formatted jobs, and on creative jobs made
  // before the server kept these. `hskStandard` is HSK only; `courseName` is for CourseType.Other.
  courseType: CourseType | null;
  courseName: string;
  hskStandard: HskStandard | null;
  level: number | null;
  lessonNumbers: number[] | null;
  csv: string;
  // How many rows the model had written when the server last heard, while the job runs; 0 before the first.
  progressRows: number;
  errorStatus: number;
  errorCode: string;
  errorMessage: string;
  createdAt: string;
  finishedAt: string | null;
  // Whether "Tạo lại" can send a failed job again, and until when for one whose images the server keeps
  // only for a while (null for a job without images or that cannot be retried).
  retryable: boolean;
  retryUntil: string | null;
}

// What a failed job says to the user, by the server's error code (csvgen's Failure* codes and the handler's own).
// The server messages are English, so none of them is shown as written. Jobs from before the codes fall back on
// the status.
const FAILED_JOB_MESSAGES: Record<string, string> = {
  timeout: 'Quá lâu. Gửi lại hoặc giảm số ảnh.',
  interrupted: 'Bị gián đoạn. Gửi lại.',
  truncated: 'Đề quá dài. Giảm số câu hoặc số bài.',
  filtered: 'Nội dung bị chặn. Đổi ảnh hoặc bài.',
  overloaded: 'AI đang quá tải. Thử lại sau ít phút.',
  bad_output: 'Kết quả lỗi. Gửi lại.',
  provider_config: 'AI tạm ngưng. Báo quản trị viên.',
  nothing_to_play: 'Không bài nào đủ từ. Chọn bài khác.',
};

export function failedJobMessage(job: AiJob): string {
  const byCode = FAILED_JOB_MESSAGES[job.errorCode];
  if (byCode) {
    return byCode;
  }
  switch (job.errorStatus) {
    case 422:
      return 'Không bài nào đủ từ. Chọn bài khác.';
    case 504:
      return 'Quá lâu. Gửi lại hoặc giảm số ảnh.';
    case 502:
      return 'Thử lại sau ít phút.';
    default:
      return 'Không rõ lỗi.';
  }
}

export interface AiJobFilter {
  search: string;
  status: AiJobStatus | null;
  creative: boolean | null;
  language: QuizLanguage | null;
  exportType: ExportType | null;
  courseType: CourseType | null;
  hskStandard: HskStandard | null;
  level: number | null;
  lessonNumber: number | null;
}

// Lower case with accents dropped, so "ni hao" finds "nǐ hǎo" and "cau hoi" finds "Câu hỏi".
export function normalizeForSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();
}

// Keeps the jobs matching every filter that is set. The search looks through the title, the error and the
// generated CSV itself, so a word can be found by the question or answer it appears in.
export function filterJobs(jobs: AiJob[], filter: AiJobFilter): AiJob[] {
  const needle = normalizeForSearch(filter.search.trim());
  return jobs.filter(job =>
    (filter.status === null || job.status === filter.status)
    && (filter.creative === null || job.creative === filter.creative)
    && (filter.language === null || job.language === filter.language)
    && (filter.exportType === null || job.exportType === filter.exportType)
    && (filter.courseType === null || job.courseType === filter.courseType)
    && (filter.hskStandard === null || job.hskStandard === filter.hskStandard)
    && (filter.level === null || job.level === filter.level)
    && (filter.lessonNumber === null || (job.lessonNumbers?.includes(filter.lessonNumber) ?? false))
    && (needle === '' || normalizeForSearch(`${job.title}\n${job.errorMessage}\n${job.csv}`).includes(needle)));
}

// The lesson of a creative job in words, e.g. "HSK 3.0 · cấp 4 · bài 3–5, 7"; "–" when the job has none.
export function lessonLabel(job: AiJob): string {
  if (job.courseType === null) {
    return '–';
  }
  const course = job.courseType === CourseType.Hsk ? `HSK ${job.hskStandard === HskStandard.V3 ? '3.0' : '2.0'}`
    : job.courseType === CourseType.Yct ? 'YCT'
      : job.courseType === CourseType.VocabReview10 ? 'Ôn tập từ vựng lớp 10'
        : (job.courseName || 'Khác');
  const lessons = job.lessonNumbers ?? [];
  return [course, job.level === null ? null : `cấp ${job.level}`, lessons.length === 0 ? null
    : `${job.courseType === CourseType.VocabReview10 ? 'topic' : 'bài'} ${formatLessonNumbers(lessons)}`]
    .filter(part => part !== null).join(' · ');
}
