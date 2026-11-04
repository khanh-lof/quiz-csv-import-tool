import { Injectable } from '@angular/core';
import { Utils } from '../utils';
import { QuestionDefinition } from '../models/question-definition';
import { CsvBuilderBase } from './csv-builder-base';

@Injectable({
  providedIn: 'root',
})
export class GimkitCsvBuilder extends CsvBuilderBase {
  protected override readonly CsvHeader = 'Gimkit Spreadsheet Import Template,,,,\n' +
    'Question,Correct Answer,Incorrect Answer 1,Incorrect Answer 2 (Optional),Incorrect Answer 3 (Optional)';
  private separator = ',';

  public buildFromRows(rows: QuestionDefinition[]) {
    let csvResult = this.CsvHeader;


    csvResult += '\n' +
      rows
        .map(row => {
            const possibleIncorrectAnswer = rows.filter(x => x.question !== row.question);
            const cells = this.fillWithOtherAnswers([row.question, row.answer], 5, possibleIncorrectAnswer);
            return cells.map(x => Utils.escapeCsvField(x)).join(this.separator);
          }
        )
        .join('\n');
    return csvResult;
  }
}
