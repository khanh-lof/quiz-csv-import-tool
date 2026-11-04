import { Injectable } from '@angular/core';

import { parseCsvRows } from '../models/csv-text';
import { QuestionDefinition } from '../models/question-definition';
import { QuestionType } from '../models/question-type';

@Injectable({ providedIn: 'root' })
export class CsvImportService {
  parseCsv(content: string): QuestionDefinition[] {
    const normalized = content.replace(/\r\n/g, '\n').trim();
    if (!normalized) {
      return [];
    }

    const rows = this.parseCsvRows(normalized);
    const [headerRow, ...dataRows] = rows;

    if (!headerRow) {
      return [];
    }

    const headerMap = this.getHeaderIndexMap(headerRow);

    return dataRows
      .filter((row) => row.some((cell) => cell.length > 0))
      .map((row) => ({
        question: row[headerMap.question] ?? '',
        answer: row[headerMap.answer] ?? '',
        questionType: QuestionType.MultipleChoice
      }))
      .filter((row) => row.question || row.answer);
  }

  // The raw cells of every row, with no header handling: for showing a CSV the way it is laid out.
  parseCsvRows(content: string): string[][] {
    return parseCsvRows(content);
  }

  private getHeaderIndexMap(headerRow: string[]): { question: number; answer: number } {
    const questionIndex = headerRow.findIndex((header) => this.normalizeHeader(header) === 'cauhoi');
    const answerIndex = headerRow.findIndex((header) => this.normalizeHeader(header) === 'dapan');

    return {
      question: questionIndex >= 0 ? questionIndex : 0,
      answer: answerIndex >= 0 ? answerIndex : 1,
    };
  }

  private normalizeHeader(header: string): string {
    return header
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/\s+/g, '')
      .trim();
  }
}
