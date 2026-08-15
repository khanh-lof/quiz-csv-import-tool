import { Injectable } from '@angular/core';
import { QuestionDefinition } from '../components/vocabulary-table/vocabulary-table';

@Injectable({providedIn: 'root'})
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
      }))
      .filter((row) => row.question || row.answer);
  }

  private parseCsvRows(content: string): string[][] {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentValue = '';
    let inQuotes = false;

    for (let i = 0; i < content.length; i += 1) {
      const char = content[i];

      if (char === '"') {
        if (inQuotes && content[i + 1] === '"') {
          currentValue += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === ',' && !inQuotes) {
        currentRow.push(currentValue.trim());
        currentValue = '';
        continue;
      }

      if ((char === '\n' || char === '\r') && !inQuotes) {
        if (char === '\r' && content[i + 1] === '\n') {
          i += 1;
        }
        currentRow.push(currentValue.trim());
        rows.push(currentRow);
        currentRow = [];
        currentValue = '';
        continue;
      }

      currentValue += char;
    }

    if (currentValue.length > 0 || currentRow.length > 0) {
      currentRow.push(currentValue.trim());
      rows.push(currentRow);
    }

    return rows;
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
