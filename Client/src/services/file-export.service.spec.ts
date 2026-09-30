import { TestBed } from '@angular/core/testing';
import * as XLSX from 'xlsx';
import { FileExportService } from './file-export.service';
import { WaygroundCsvBuilder } from './wayground-csv-builder';
import { ExportType } from '../models/export-type';
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

  it('returns no bytes for a CSV platform', () => {
    const rows = ['一', '二', '三', '四', '五'].map((question, i) =>
      ({question, answer: `${i + 1}`, questionType: QuestionType.MultipleChoice}));
    const exported = service.exportFile('Lesson-Gimkit.csv', rows, ExportType.GimKit);

    expect(exported).toEqual({fileName: 'Lesson-Gimkit.csv'});
  });
});
