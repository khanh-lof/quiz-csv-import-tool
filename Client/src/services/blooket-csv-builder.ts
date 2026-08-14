import {Injectable} from '@angular/core';
import {QuestionDefinition} from '../components/vocabulary-table/vocabulary-table';
import {Utils} from '../utils';

@Injectable({
  providedIn: 'root',
})
export class BlooketCsvBuilder {
  private separator = ',';

  public build(rows: QuestionDefinition[]) {
    let csvResult = '"Blooket\n' +
      'Import Template",,,,,,,\n' +
      'Question #,Question Text,Answer 1,Answer 2,Answer 3,Answer 4,Time Limit (sec),Correct Answer(s)';

    csvResult += '\n' +
      rows
        .map(row => {
            const possibleIncorrectAnswer = rows.filter(x => x.question !== row.question);
            let answers = [row.answer];
            const cells = [rows.indexOf(row) + 1, row.question];
            while (answers.length < 4) {
              let incorrectAnswer = Utils.getRandomItem(possibleIncorrectAnswer).answer;
              if (!answers.includes(incorrectAnswer)) {
                answers.push(incorrectAnswer);
              }
            }
            answers = Utils.shuffle(answers);
            return cells.concat([...answers, 20, (answers.indexOf(row.answer) + 1).toString()]).map(x => Utils.escapeCsvField(x)).join(this.separator);
          }
        )
        .join('\n');
    return csvResult;
  }
}
