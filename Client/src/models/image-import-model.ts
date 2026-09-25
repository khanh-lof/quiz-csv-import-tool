import { AIGenerationMode } from './aigeneration-mode';
import { ExportType } from './export-type';
import { CourseType } from './course-type';

export interface ImageImportModel {
  courseType: CourseType | null;
  courseName: string | null;
  level: number | null;
  lessonNumber: number | null;
  AIMode: AIGenerationMode | null;
  exportType: ExportType | null;
  // "Độ thông minh" 1 = Thấp, 2 = Cao, only used in Auto mode; the server maps it to a model (LLM_INTELLIGENCE_MODELS).
  intelligence: number | null;
}
