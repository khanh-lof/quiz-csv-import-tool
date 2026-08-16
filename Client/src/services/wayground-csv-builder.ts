import { Injectable } from '@angular/core';
import { Utils } from '../utils';
import { QuestionDefinition } from '../models/question-definition';
import { QuestionType } from '../models/question-type';
import { CsvBuilderBase } from './csv-builder-base';
@Injectable({
  providedIn: 'root',
})
export class WaygroundCsvBuilder extends CsvBuilderBase {
  private separator = ',';

  protected override readonly CsvHeader = `Question Text,Question Type,Option 1,Option 2,Option 3,Option 4,Option 5,Correct Answer,Time in seconds,Image Link,Answer explanation
"Text of the question

(required)


","Question Type

(default is Multiple Choice)

","Text for option 1

(required in all cases except open-ended & draw questions)","Text for option 2

(required in all cases except open-ended & draw questions)","Text for option 3

(optional)


","Text for option 4

(optional)


","Text for option 5

(optional)


","The correct option choice (between 1-5).

Leave blank for ""Open-Ended"", ""Poll"", ""Draw"" and ""Fill-in-the-Blank"".","Time in seconds

(optional, default value is 30 seconds)
","Link of the image

(optional)


","Explanation for the answer
(optional)


"`;

  public buildFromRows(rows: QuestionDefinition[]) {
    let csvResult = this.CsvHeader;


    csvResult += '\n' +
      rows
        .map(row => {
            const possibleIncorrectAnswer = rows.filter(x => x.question !== row.question);
            let cells = [row.question, this.resolveQuestionTypeLabel(row.questionType)];
            if (row.questionType === QuestionType.FillInTheBlank) {
              cells = cells.concat([row.answer, '', '', '', '', '', '', '', '']);
            }
            else {
              let answers = this.generateAnswers(row, possibleIncorrectAnswer);
              cells = cells.concat([...answers, '', (answers.indexOf(row.answer) + 1).toString(), '', '', '']);
            }
            return cells.map(x => Utils.escapeCsvField(x)).join(this.separator);
          }
        )
        .join('\n');
    return csvResult;
  }

  private generateAnswers(row: QuestionDefinition, possibleIncorrectAnswer: QuestionDefinition[]) {
    let answers = [row.answer];
    while (answers.length < 4) {
      let incorrectAnswer = Utils.getRandomItem(possibleIncorrectAnswer).answer;
      if (!answers.includes(incorrectAnswer)) {
        answers.push(incorrectAnswer);
      }
    }
    return Utils.shuffle(answers);
  }

  private resolveQuestionTypeLabel(questionType: QuestionType) {
    switch (questionType) {
      case QuestionType.MultipleChoice:
        return 'Multiple Choice';
      case QuestionType.FillInTheBlank:
        return 'Fill-in-the-Blank';
      default:
        return '';
    }
  }
}
