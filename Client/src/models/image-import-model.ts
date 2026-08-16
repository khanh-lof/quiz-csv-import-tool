import { AIGenerationMode } from './aigeneration-mode';
import { ExportType } from './export-type';

export interface ImageImportModel {
  hskLevel: number | null;
  lessonNumber: number | null;
  AIMode: AIGenerationMode | null;
  exportType: ExportType | null;
}
