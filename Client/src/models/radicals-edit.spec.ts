import { HttpErrorResponse } from '@angular/common/http';
import {
  editRowCount,
  flaggedEdit,
  RadicalsEdit,
  radicalsEditError,
  withChar,
  withComponent,
  withWord
} from './radicals-edit';

export function sampleEdit(): RadicalsEdit {
  return {
    words: [
      { hanzi: '借', lessons: [3], pinyin: 'jiexyz', meaning: 'mượn', ai: true, uncertain: false, dropped: false, problem: 'pinyin' },
      { hanzi: '好人', lessons: [3, 4], pinyin: '', meaning: 'người tốt', ai: true, uncertain: false, dropped: true },
    ],
    chars: [{ char: '图', meaning: '', inWords: ['图书馆'], ai: false, problem: 'missing' }],
    components: [{ component: '囗', name: 'Vi', pinyin: 'wéi', meaning: 'vây quanh', inChars: ['图'], ai: true }],
  };
}

describe('radicals edit', () => {
  const failure = (status: number, error: unknown = '') => new HttpErrorResponse({ status, error });

  it('changes one row and clears its problem', () => {
    const edit = sampleEdit();
    const changed = withWord(edit, '借', { pinyin: 'jiè' });

    expect(changed.words[0]).toEqual({ ...edit.words[0], pinyin: 'jiè', problem: undefined });
    expect(changed.words[1]).toBe(edit.words[1]);
    expect(edit.words[0].pinyin).toBe('jiexyz');
    expect(withChar(edit, '图', 'bức tranh').chars[0]).toEqual({ ...edit.chars[0], meaning: 'bức tranh', problem: undefined });
    expect(withComponent(edit, '囗', { name: 'Vây' }).components[0].name).toBe('Vây');
  });

  it('counts the rows', () => {
    expect(editRowCount(sampleEdit())).toBe(4);
    expect(editRowCount({ words: [], chars: [], components: [] })).toBe(0);
  });

  it('takes the flagged table only from a 422', () => {
    expect(flaggedEdit(failure(422, sampleEdit()))).toEqual(sampleEdit());
    expect(flaggedEdit(failure(422, 'text'))).toBeNull();
    expect(flaggedEdit(failure(400, sampleEdit()))).toBeNull();
    expect(flaggedEdit(new Error('x'))).toBeNull();
  });

  it('words the server\'s refusals', () => {
    expect(radicalsEditError(failure(404, 'Job not found'), 'x')).toBe('Không tìm thấy bài này.');
    expect(radicalsEditError(failure(409, 'Job cannot be edited.'), 'x')).toBe('Bài cũ, không sửa được.');
    expect(radicalsEditError(failure(409, 'No lesson has enough words for a group.'), 'x')).toBe('Không bài nào đủ từ.');
    expect(radicalsEditError(failure(400, 'Invalid corrections.'), 'Không lưu được.')).toBe('Không lưu được.');
    expect(radicalsEditError(new Error('offline'), 'Không tải được.')).toBe('Không tải được.');
  });
});
