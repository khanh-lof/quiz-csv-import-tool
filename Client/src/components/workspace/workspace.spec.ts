import { breadcrumbFor } from './workspace';

describe('breadcrumbFor', () => {
  it('shows a top-level page alone', () => {
    expect(breadcrumbFor('/quiz')).toEqual([{ label: 'app.workspace.navManualQuiz' }]);
  });

  it('puts a grouped page under its group, which is no link', () => {
    expect(breadcrumbFor('/ai')).toEqual([{ label: 'app.workspace.navAi' }, { label: 'app.workspace.navCreateQuiz' }]);
    expect(breadcrumbFor('/ai-history')).toEqual([{ label: 'app.workspace.navAi' }, { label: 'app.workspace.navHistory' }]);
    expect(breadcrumbFor('/assignments')).toEqual([{ label: 'app.workspace.navGame' }, { label: 'app.workspace.navAssignments' }]);
  });

  it('links an assignment leaderboard back to the list', () => {
    expect(breadcrumbFor('/assignments/abc123')).toEqual([
      { label: 'app.workspace.navGame' },
      {
        label: 'app.workspace.navAssignments',
        link: '/assignments'
      },
      { label: 'common.leaderboardTitle' }
    ]);
  });

  it('links a "Ghép bộ thủ" exercise back to the history', () => {
    expect(breadcrumbFor('/ai-history/radicals/abc123')).toEqual([
      { label: 'app.workspace.navAi' },
      {
        label: 'app.workspace.navHistory',
        link: '/ai-history'
      },
      { label: 'app.workspace.navRadicals' }
    ]);
  });

  it('ignores the query string and fragment', () => {
    expect(breadcrumbFor('/quiz?from=ai#top')).toEqual([{ label: 'app.workspace.navManualQuiz' }]);
  });

  it('does not take /ai-history for /ai', () => {
    expect(breadcrumbFor('/ai-history').at(-1)?.label).toBe('app.workspace.navHistory');
  });
});
