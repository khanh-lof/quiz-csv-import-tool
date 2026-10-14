import { breadcrumbFor } from './workspace';

describe('breadcrumbFor', () => {
  it('shows a top-level page alone', () => {
    expect(breadcrumbFor('/quiz')).toEqual([{label: 'Quiz thủ công'}]);
  });

  it('puts a grouped page under its group, which is no link', () => {
    expect(breadcrumbFor('/ai')).toEqual([{label: 'AI'}, {label: 'Tạo quiz'}]);
    expect(breadcrumbFor('/ai-history')).toEqual([{label: 'AI'}, {label: 'Lịch sử'}]);
    expect(breadcrumbFor('/assignments')).toEqual([{label: 'Game'}, {label: 'Bài đã giao'}]);
  });

  it('links an assignment ranking back to the list', () => {
    expect(breadcrumbFor('/assignments/abc123')).toEqual([
      {label: 'Game'},
      {label: 'Bài đã giao', link: '/assignments'},
      {label: 'Bảng xếp hạng'}
    ]);
  });

  it('ignores the query string and fragment', () => {
    expect(breadcrumbFor('/quiz?from=ai#top')).toEqual([{label: 'Quiz thủ công'}]);
  });

  it('does not take /ai-history for /ai', () => {
    expect(breadcrumbFor('/ai-history').at(-1)?.label).toBe('Lịch sử');
  });
});
