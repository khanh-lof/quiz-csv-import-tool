import { QuestionType } from './question-type';

export interface QuestionDefinition {
  question: string;
  answer: string;
  questionType: QuestionType;
}
