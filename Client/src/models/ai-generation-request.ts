import { AIGenerationMode } from './aigeneration-mode';
import { ExportType } from './export-type';
import { CourseType } from './course-type';
import { HskStandard } from './hsk-standard';

export interface AiGenerationRequest {
  courseType: CourseType | null;
  courseName: string | null;
  // Only sent for HSK.
  hskStandard: HskStandard | null;
  level: number | null;
  lessonNumber: number | null;
  AIMode: AIGenerationMode | null;
  exportType: ExportType | null;
  // "Độ thông minh" 1 = Thấp, 2 = Cao, only used in Auto mode; the server maps it to a model (LLM_INTELLIGENCE_MODELS).
  intelligence: number | null;
  // The two below only apply to a Game (ExportType.GestureQuiz) and are sent for it alone.
  // The stage numbers (1-6) of the games the quiz should have; null asks for all six.
  gestureStages: number[] | null;
  // How many questions each of those stages gets (4-10); null asks for the server's default.
  questionsPerStage: number | null;
}
