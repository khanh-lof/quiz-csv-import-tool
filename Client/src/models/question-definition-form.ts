import { FormControl } from "@angular/forms";
import { QuestionType } from './question-type';

export interface QuestionDefinitionForm {
  question: FormControl<string>;
  answer: FormControl<string>;
  questionType: FormControl<QuestionType>;
}
