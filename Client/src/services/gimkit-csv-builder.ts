import { Injectable } from '@angular/core';
import { Utils } from '../utils';
import { QuestionDefinition } from '../models/question-definition';
import { CsvBuilderBase } from './csv-builder-base';

@Injectable({
  providedIn: 'root',
})
export class GimkitCsvBuilder extends CsvBuilderBase {
  private separator = ',';

  protected override readonly CsvHeader = 'Gimkit Spreadsheet Import Template,,,,\n' +
    'Question,Correct Answer,Incorrect Answer 1,Incorrect Answer 2 (Optional),Incorrect Answer 3 (Optional)';

  public buildFromRows(rows: QuestionDefinition[]) {
    let csvResult = this.CsvHeader;


    csvResult += '\n' +
      rows
        .map(row => {
            const possibleIncorrectAnswer = rows.filter(x => x.question !== row.question);
            const cells = [row.question, row.answer];
            while (cells.length < 5) {
              let incorrectAnswer = Utils.getRandomItem(possibleIncorrectAnswer).answer;
              if (!cells.includes(incorrectAnswer)) {
                cells.push(incorrectAnswer);
              }
            }
            return cells.map(x => Utils.escapeCsvField(x)).join(this.separator);
          }
        )
        .join('\n');
    return csvResult;
  }
}
