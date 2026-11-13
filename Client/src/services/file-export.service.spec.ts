import { TestBed } from '@angular/core/testing';
import { provideNzI18n } from 'ng-zorro-antd/i18n';
import { appLocale } from '../i18n/app-locale';
import { Messages } from '../i18n/messages';
import * as XLSX from 'xlsx';
import { FileExportService } from './file-export.service';
import { WaygroundCsvBuilder } from './wayground-csv-builder';
import { ExportType } from '../models/export-type';
import { GESTURE_QUIZ_COLUMNS } from '../models/gesture-quiz';
import { QuestionType } from '../models/question-type';

describe('FileExportService Wayground export', () => {
  let service: FileExportService;

  beforeEach(() => {
    service = TestBed.inject(FileExportService);
    // Keep the test from triggering a real download.
    spyOn(HTMLAnchorElement.prototype, 'click');
  });

  it('builds an .xlsx whose first row is the Wayground header', () => {
    const csv = TestBed.inject(WaygroundCsvBuilder).buildFromCsvContent('你好,Multiple Choice,xin chào,tạm biệt,,,,1,,,');
    const workbook = XLSX.read(FileExportService.buildXlsx(csv), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });

    expect(rows[0].slice(0, 3)).toEqual(['Question Text', 'Question Type', 'Option 1']);
    expect(rows[2][0]).toBe('你好');
  });

  it('returns the downloaded .xlsx name and bytes', () => {
    const rows = ['一', '二', '三', '四', '五'].map((question, i) =>
      ({
        question,
        answer: `${i + 1}`,
        questionType: QuestionType.MultipleChoice
      }));
    const exported = service.exportFile('Lesson-Wayground.csv', rows, ExportType.Wayground);

    expect(exported?.fileName).toBe('Lesson-Wayground.xlsx');
    expect(exported?.xlsx?.length).toBeGreaterThan(0);
  });

  it('builds the .xlsx without downloading it when asked', () => {
    const rows = ['一', '二', '三', '四', '五'].map((question, i) =>
      ({
        question,
        answer: `${i + 1}`,
        questionType: QuestionType.MultipleChoice
      }));
    const exported = service.exportFile('Lesson-Wayground.csv', rows, ExportType.Wayground, false);

    expect(exported?.xlsx?.length).toBeGreaterThan(0);
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('returns the CSV as UTF-8 bytes for Gimkit, for the extension to import', () => {
    const rows = ['一', '二', '三', '四', '五'].map((question, i) =>
      ({
        question,
        answer: `${i + 1}`,
        questionType: QuestionType.MultipleChoice
      }));
    const exported = service.exportFile('Lesson-Gimkit.csv', rows, ExportType.GimKit, false);

    expect(exported?.fileName).toBe('Lesson-Gimkit.csv');
    expect(exported?.xlsx).toBeUndefined();
    expect(new TextDecoder().decode(exported?.csv)).toContain('Gimkit Spreadsheet Import Template');
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('returns no bytes for Blooket', () => {
    const rows = ['一', '二', '三', '四', '五'].map((question, i) =>
      ({
        question,
        answer: `${i + 1}`,
        questionType: QuestionType.MultipleChoice
      }));
    const exported = service.exportFile('Lesson-Blooket.csv', rows, ExportType.Blooket);

    expect(exported).toEqual({ fileName: 'Lesson-Blooket.csv' });
  });
});

describe('FileExportService Game export', () => {
  const rows = '1,你好是什么意思?,Xin chào,,,,\n2,"我叫___,你呢?",Lan,Mai,Hoa,,Điền tên';
  let service: FileExportService;
  let blobs: Blob[];
  let downloadNames: string[];
  let messages: Messages;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideNzI18n(appLocale)] });
    messages = TestBed.inject(Messages);
    service = TestBed.inject(FileExportService);
    blobs = [];
    downloadNames = [];
    // Catches what would be downloaded instead of triggering a real download.
    spyOn(URL, 'createObjectURL').and.callFake((blob: Blob | MediaSource) => {
      blobs.push(blob as Blob);
      return 'blob:quiztool-test';
    });
    spyOn(URL, 'revokeObjectURL');
    spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) {
      downloadNames.push(this.download);
    });
  });

  it('downloads a .csv that starts with the gesture quiz header, then the rows', async () => {
    const exported = service.exportFileFromCsvContent('HSK3-Bai5-Game.csv', rows, ExportType.GestureQuiz);

    expect(exported).toEqual({ fileName: 'HSK3-Bai5-Game.csv' });
    expect(downloadNames).toEqual(['HSK3-Bai5-Game.csv']);
    expect(blobs.length).toBe(1);
    expect(blobs[0].type).toBe('text/csv;charset=utf-8');
    expect(await blobs[0].text()).toBe(`${GESTURE_QUIZ_COLUMNS.join(',')}\n${rows}`);
  });

  it('does not download when asked not to', () => {
    const exported = service.exportFileFromCsvContent('Quiz.csv', rows, ExportType.GestureQuiz, false);

    expect(exported).toEqual({ fileName: 'Quiz.csv' });
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('cannot be built from the table rows, which have no stages', () => {
    const tableRows = [{
      question: '一',
      answer: '1',
      questionType: QuestionType.MultipleChoice
    }];

    expect(() => service.exportFile('Quiz.csv', tableRows, ExportType.GestureQuiz)).toThrowError(/AI/);
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('names the platform', () => {
    expect(FileExportService.platformName(ExportType.GestureQuiz, messages)).toBe('Game');
    expect(FileExportService.platformName(ExportType.Wayground, messages)).toBe('Wayground');
  });

  it('names the file with dashes in place of spaces, in the label and the platform', () => {
    expect(FileExportService.buildFileName('HSK3-Bai5', ExportType.GestureQuiz, messages)).toBe('HSK3-Bai5-Game.csv');
    expect(FileExportService.buildFileName(' Boya  Bai 2 ', ExportType.GestureQuiz, messages)).toBe('Boya-Bai-2-Game.csv');
  });

  it('keeps the file names of the other platforms', () => {
    expect(FileExportService.buildFileName('HSK3-Bai5', ExportType.GimKit, messages)).toBe('HSK3-Bai5-Gimkit.csv');
    expect(FileExportService.buildFileName('HSK3-Bai5', ExportType.Blooket, messages)).toBe('HSK3-Bai5-Blooket.csv');
    expect(FileExportService.buildFileName('HSK3-Bai5', ExportType.Wayground, messages)).toBe('HSK3-Bai5-Wayground.csv');
    expect(FileExportService.buildFileName('a/b:c', ExportType.GimKit, messages)).toBe('abc-Gimkit.csv');
  });
});
