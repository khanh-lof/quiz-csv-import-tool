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
}
