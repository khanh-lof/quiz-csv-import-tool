import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';

// What the teacher may correct in a finished "Ghép bộ thủ" exercise, as `GET csv/jobs/{id}/radicals` answers it and
// `PUT` takes it back with values changed (csvgen.RadicalsEdit on the server, kept in step by hand): the words whose
// pinyin or meaning the AI wrote, that the teacher changed, or that were left out for want of a pinyin, and the
// characters and components the server's curated notes lack. A 422 answer is the same table with `problem` set on
// the rows that need another value.

// 'pinyin': it does not cut into one syllable per character; 'missing': the exercise needs this meaning.
export type EditProblem = 'pinyin' | 'missing';

export interface EditWord {
  hanzi: string;
  lessons: number[];
  pinyin: string;
  meaning: string;
  ai: boolean;
  uncertain: boolean;
  // Not in the exercise: a pinyin that cuts brings it back.
  dropped: boolean;
  problem?: EditProblem;
}

export interface EditChar {
  char: string;
  meaning: string;
  inWords: string[];
  ai: boolean;
  problem?: EditProblem;
}

export interface EditComponent {
  component: string;
  name: string;
  pinyin: string;
  meaning: string;
  inChars: string[];
  ai: boolean;
  problem?: EditProblem;
}

export interface RadicalsEdit {
  words: EditWord[];
  chars: EditChar[];
  components: EditComponent[];
}

// The server's limits (csvgen's maxEditPinyinRunes and maxEditNoteRunes).
export const MAX_EDIT_PINYIN_LENGTH = 100;
export const MAX_EDIT_NOTE_LENGTH = 200;

export function editRowCount(edit: RadicalsEdit): number {
  return edit.words.length + edit.chars.length + edit.components.length;
}

// A changed value is the teacher's answer to the row's problem, which goes until the server says otherwise.
export function withWord(edit: RadicalsEdit, hanzi: string, change: Partial<Pick<EditWord, 'pinyin' | 'meaning'>>): RadicalsEdit {
  return { ...edit, words: edit.words.map(row => row.hanzi === hanzi ? { ...row, ...change, problem: undefined } : row) };
}

export function withChar(edit: RadicalsEdit, char: string, meaning: string): RadicalsEdit {
  return { ...edit, chars: edit.chars.map(row => row.char === char ? { ...row, meaning, problem: undefined } : row) };
}

export function withComponent(edit: RadicalsEdit, component: string,
                              change: Partial<Pick<EditComponent, 'name' | 'pinyin' | 'meaning'>>): RadicalsEdit {
  return {
    ...edit,
    components: edit.components.map(row => row.component === component ? { ...row, ...change, problem: undefined } : row)
  };
}

// The table a refused save sent back, with its rows flagged; null for any other failure.
export function flaggedEdit(err: unknown): RadicalsEdit | null {
  return err instanceof HttpErrorResponse && err.status === HttpStatusCode.UnprocessableEntity && Array.isArray(err.error?.words)
    ? err.error as RadicalsEdit
    : null;
}

// What a failed load or save of the table says to the teacher; `fallback` for a failure with nothing more to say.
export function radicalsEditError(err: unknown, fallback: string): string {
  if (!(err instanceof HttpErrorResponse)) {
    return fallback;
  }
  if (err.status === HttpStatusCode.NotFound) {
    return 'Không tìm thấy bài này.';
  }
  if (err.status === HttpStatusCode.Conflict && err.error === 'Job cannot be edited.') {
    return 'Bài này tạo trước khi có chức năng sửa.';
  }
  if (err.status === HttpStatusCode.Conflict && err.error === 'No lesson has enough words for a group.') {
    return 'Không bài nào còn đủ từ để ghép bộ.';
  }
  return fallback;
}
