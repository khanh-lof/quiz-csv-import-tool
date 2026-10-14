import { TestBed } from '@angular/core/testing';
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
    const workbook = XLSX.read(FileExportService.buildXlsx(csv), {type: 'array'});
    const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[workbook.SheetNames[0]], {header: 1});

    expect(rows[0].slice(0, 3)).toEqual(['Question Text', 'Question Type', 'Option 1']);
    expect(rows[2][0]).toBe('你好');
  });

  it('returns the downloaded .xlsx name and bytes', () => {
    const rows = ['一', '二', '三', '四', '五'].map((question, i) =>
      ({question, answer: `${i + 1}`, questionType: QuestionType.MultipleChoice}));
    const exported = service.exportFile('Lesson-Wayground.csv', rows, ExportType.Wayground);

    expect(exported?.fileName).toBe('Lesson-Wayground.xlsx');
    expect(exported?.xlsx?.length).toBeGreaterThan(0);
  });

  it('builds the .xlsx without downloading it when asked', () => {
    const rows = ['一', '二', '三', '四', '五'].map((question, i) =>
      ({question, answer: `${i + 1}`, questionType: QuestionType.MultipleChoice}));
    const exported = service.exportFile('Lesson-Wayground.csv', rows, ExportType.Wayground, false);

    expect(exported?.xlsx?.length).toBeGreaterThan(0);
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('returns no bytes for a CSV platform', () => {
    const rows = ['一', '二', '三', '四', '五'].map((question, i) =>
      ({question, answer: `${i + 1}`, questionType: QuestionType.MultipleChoice}));
    const exported = service.exportFile('Lesson-Gimkit.csv', rows, ExportType.GimKit);

    expect(exported).toEqual({fileName: 'Lesson-Gimkit.csv'});
  });
});

describe('FileExportService Game export', () => {
  const rows = '1,你好是什么意思?,Xin chào,,,,\n2,"我叫___,你呢?",Lan,Mai,Hoa,,Điền tên';
  let service: FileExportService;
  let blobs: Blob[];
  let downloadNames: string[];

  beforeEach(() => {
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

    expect(exported).toEqual({fileName: 'HSK3-Bai5-Game.csv'});
    expect(downloadNames).toEqual(['HSK3-Bai5-Game.csv']);
    expect(blobs.length).toBe(1);
    expect(blobs[0].type).toBe('text/csv;charset=utf-8');
    expect(await blobs[0].text()).toBe(`${GESTURE_QUIZ_COLUMNS.join(',')}\n${rows}`);
  });

  it('does not download when asked not to', () => {
    const exported = service.exportFileFromCsvContent('Quiz.csv', rows, ExportType.GestureQuiz, false);

    expect(exported).toEqual({fileName: 'Quiz.csv'});
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('cannot be built from the table rows, which have no stages', () => {
    const tableRows = [{question: '一', answer: '1', questionType: QuestionType.MultipleChoice}];

    expect(() => service.exportFile('Quiz.csv', tableRows, ExportType.GestureQuiz)).toThrowError(/AI/);
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('names the platform', () => {
    expect(FileExportService.platformName(ExportType.GestureQuiz)).toBe('Game');
    expect(FileExportService.platformName(ExportType.Wayground)).toBe('Wayground');
  });

  it('names the file with dashes in place of spaces, in the label and the platform', () => {
    expect(FileExportService.buildFileName('HSK3-Bai5', ExportType.GestureQuiz)).toBe('HSK3-Bai5-Game.csv');
    expect(FileExportService.buildFileName(' Boya  Bai 2 ', ExportType.GestureQuiz)).toBe('Boya-Bai-2-Game.csv');
  });

  it('keeps the file names of the other platforms', () => {
    expect(FileExportService.buildFileName('HSK3-Bai5', ExportType.GimKit)).toBe('HSK3-Bai5-Gimkit.csv');
    expect(FileExportService.buildFileName('HSK3-Bai5', ExportType.Blooket)).toBe('HSK3-Bai5-Blooket.csv');
    expect(FileExportService.buildFileName('HSK3-Bai5', ExportType.Wayground)).toBe('HSK3-Bai5-Wayground.csv');
    expect(FileExportService.buildFileName('a/b:c', ExportType.GimKit)).toBe('abc-Gimkit.csv');
  });
});
