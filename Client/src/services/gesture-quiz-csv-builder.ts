import { Injectable } from '@angular/core';
import { QuestionDefinition } from '../models/question-definition';
import { GESTURE_QUIZ_COLUMNS } from '../models/gesture-quiz';
import { CsvBuilderBase } from './csv-builder-base';

@Injectable({
  providedIn: 'root',
})
export class GestureQuizCsvBuilder extends CsvBuilderBase {
  protected override readonly CsvHeader = GESTURE_QUIZ_COLUMNS.join(',');

  public buildFromRows(_rows: QuestionDefinition[]): string {
    // Every row of a gesture quiz belongs to one of six stages with its own rules (true/false, word order, ...),
    // and only the AI assigns them. The question/answer table has no stages, so it cannot build this quiz
    // and does not offer the platform; reaching this is a bug, not something the user can fix.
    throw new Error('Quiz cử chỉ chỉ do AI tạo, bảng thủ công không xuất được.');
  }
}
