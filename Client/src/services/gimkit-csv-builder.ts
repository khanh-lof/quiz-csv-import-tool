import {Injectable} from '@angular/core';
import {QuestionDefinition} from '../components/vocabulary-table/vocabulary-table';
import {Utils} from '../utils';

@Injectable({
  providedIn: 'root',
})
export class GimkitCsvBuilder {
  private separator = ',';

  public build(rows: QuestionDefinition[]) {
    let csvResult = 'Gimkit Spreadsheet Import Template,,,,\n' +
      'Question,Correct Answer,Incorrect Answer 1,Incorrect Answer 2 (Optional),Incorrect Answer 3 (Optional)';


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
