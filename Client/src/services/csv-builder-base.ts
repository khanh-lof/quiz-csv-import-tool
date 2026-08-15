import { QuestionDefinition } from '../models/question-definition';

export abstract class CsvBuilderBase {
  protected abstract readonly CsvHeader: string;
  public abstract buildFromRows(rows: QuestionDefinition[]): string;

  public buildFromCsvContent(csvContent: string) {
    let csvResult = this.CsvHeader;
    csvResult += '\n' + csvContent;
    return csvResult;
  }
}
