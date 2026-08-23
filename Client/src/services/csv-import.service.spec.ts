import { CsvImportService } from './csv-import.service';
import { QuestionType } from '../models/question-type';

describe('CsvImportService', () => {
  let service: CsvImportService;

  beforeEach(() => {
    service = new CsvImportService();
  });

  it('parses quoted values with commas inside cells', () => {
    const rows = service.parseCsv('Câu hỏi,Đáp án\n"Hello, world","Chào, bạn"');

    expect(rows).toEqual([
      {question: 'Hello, world', answer: 'Chào, bạn', questionType: QuestionType.MultipleChoice},
    ]);
  });
});
