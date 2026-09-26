import { Injectable } from '@angular/core';
import { QuestionDefinition } from '../models/question-definition';

// Hands rows produced on another screen (the AI page's formatted mode) to the vocabulary table, which
// takes them once on arrival. Kept in memory only, so a reload never imports the same rows twice.
@Injectable({providedIn: 'root'})
export class PendingImportService {
  private rows: QuestionDefinition[] | null = null;

  set(rows: QuestionDefinition[]): void {
    this.rows = rows;
  }

  take(): QuestionDefinition[] | null {
    const rows = this.rows;
    this.rows = null;
    return rows;
  }
}
