import { AiJob, AiJobFilter, filterJobs } from './ai-job';
import { ExportType } from './export-type';

function job(overrides: Partial<AiJob>): AiJob {
  return {
    id: 'id', status: 'done', title: 'HSK3-Bai5', creative: true, exportType: ExportType.GimKit, intelligence: 1,
    imageCount: 0, csv: '', errorStatus: 0, errorMessage: '', createdAt: '2026-10-13T00:00:00Z', finishedAt: null,
    ...overrides,
  };
}

const NO_FILTER: AiJobFilter = {search: '', status: null, creative: null, exportType: null};

describe('filterJobs', () => {
  const jobs = [
    job({id: 'a', title: 'HSK3-Bai5', csv: '你好,Xin chào\n谢谢,Cảm ơn'}),
    job({id: 'b', title: 'YCT1-Bai2', creative: false, exportType: null, csv: 'nǐ hǎo,Câu hỏi'}),
    job({id: 'c', title: 'Boya-Bai1', status: 'failed', exportType: ExportType.Wayground, errorMessage: 'AI generation timed out.'}),
    job({id: 'd', title: 'HSK1-Bai1', status: 'running', exportType: ExportType.Blooket}),
  ];
  const ids = (filter: Partial<AiJobFilter>) => filterJobs(jobs, {...NO_FILTER, ...filter}).map(j => j.id);

  it('keeps everything without filters', () => {
    expect(ids({})).toEqual(['a', 'b', 'c', 'd']);
  });

  it('searches the title', () => {
    expect(ids({search: 'yct1'})).toEqual(['b']);
  });

  it('searches inside the generated CSV, Chinese included', () => {
    expect(ids({search: '谢谢'})).toEqual(['a']);
    expect(ids({search: 'cảm ơn'})).toEqual(['a']);
  });

  it('ignores accents and case, so plain letters find pinyin and Vietnamese', () => {
    expect(ids({search: 'NI HAO'})).toEqual(['b']);
    expect(ids({search: 'cau hoi'})).toEqual(['b']);
    expect(ids({search: 'xin chao'})).toEqual(['a']);
  });

  it('searches the error message', () => {
    expect(ids({search: 'timed out'})).toEqual(['c']);
  });

  it('ignores surrounding spaces in the search', () => {
    expect(ids({search: '  boya  '})).toEqual(['c']);
  });

  it('filters by status, mode and platform', () => {
    expect(ids({status: 'failed'})).toEqual(['c']);
    expect(ids({creative: false})).toEqual(['b']);
    expect(ids({exportType: ExportType.Blooket})).toEqual(['d']);
  });

  it('combines every filter that is set', () => {
    expect(ids({creative: true, status: 'done', search: 'hsk'})).toEqual(['a']);
    expect(ids({creative: false, status: 'failed'})).toEqual([]);
  });
});
