import { QuestionDefinition } from '../models/question-definition';
import { Utils } from '../utils';

export abstract class CsvBuilderBase {
  protected abstract readonly CsvHeader: string;

  public abstract buildFromRows(rows: QuestionDefinition[]): string;

  // `chosen` followed by answers of the other rows, none of them twice, until there are `size`. A text put in
  // `chosen` is one a wrong answer may not equal either. Needs enough different answers among the candidates.
  protected fillWithOtherAnswers(chosen: string[], size: number, candidates: QuestionDefinition[]): string[] {
    const filled = [...chosen];
    while (filled.length < size) {
      const candidate = Utils.getRandomItem(candidates).answer;
      if (!filled.includes(candidate)) {
        filled.push(candidate);
      }
    }
    return filled;
  }

  public buildFromCsvContent(csvContent: string) {
    let csvResult = this.CsvHeader;
    csvResult += '\n' + csvContent;
    return csvResult;
  }
}
