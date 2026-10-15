import { AiJob, AiJobFilter, filterJobs, lessonLabel } from './ai-job';
import { ExportType } from './export-type';
import { CourseType } from './course-type';
import { HskStandard } from './hsk-standard';

function job(overrides: Partial<AiJob>): AiJob {
  return {
    id: 'id',
    status: 'done',
    title: 'HSK3-Bai5',
    creative: true,
    exportType: ExportType.GimKit,
    intelligence: 1,
    imageCount: 0,
    courseType: null,
    courseName: '',
    hskStandard: null,
    level: null,
    lessonNumber: null,
    csv: '',
    errorStatus: 0,
    errorMessage: '',
    createdAt: '2026-10-13T00:00:00Z',
    finishedAt: null,
    ...overrides,
  };
}

const NO_FILTER: AiJobFilter = {
  search: '',
  status: null,
  creative: null,
  exportType: null,
  courseType: null,
  hskStandard: null,
  level: null,
  lessonNumber: null,
};

describe('filterJobs', () => {
  const jobs = [
    job({
      id: 'a',
      title: 'HSK3-Bai5',
      csv: '你好,Xin chào\n谢谢,Cảm ơn'
    }),
    job({
      id: 'b',
      title: 'YCT1-Bai2',
      creative: false,
      exportType: null,
      csv: 'nǐ hǎo,Câu hỏi'
    }),
    job({
      id: 'c',
      title: 'Boya-Bai1',
      status: 'failed',
      exportType: ExportType.Wayground,
      errorMessage: 'AI generation timed out.'
    }),
    job({
      id: 'd',
      title: 'HSK1-Bai1',
      status: 'running',
      exportType: ExportType.Blooket
    }),
  ];
  const ids = (filter: Partial<AiJobFilter>) => filterJobs(jobs, { ...NO_FILTER, ...filter }).map(j => j.id);

  it('keeps everything without filters', () => {
    expect(ids({})).toEqual(['a', 'b', 'c', 'd']);
  });

  it('searches the title', () => {
    expect(ids({ search: 'yct1' })).toEqual(['b']);
  });

  it('searches inside the generated CSV, Chinese included', () => {
    expect(ids({ search: '谢谢' })).toEqual(['a']);
    expect(ids({ search: 'cảm ơn' })).toEqual(['a']);
  });

  it('ignores accents and case, so plain letters find pinyin and Vietnamese', () => {
    expect(ids({ search: 'NI HAO' })).toEqual(['b']);
    expect(ids({ search: 'cau hoi' })).toEqual(['b']);
    expect(ids({ search: 'xin chao' })).toEqual(['a']);
  });

  it('searches the error message', () => {
    expect(ids({ search: 'timed out' })).toEqual(['c']);
  });

  it('ignores surrounding spaces in the search', () => {
    expect(ids({ search: '  boya  ' })).toEqual(['c']);
  });

  it('filters by status, mode and platform', () => {
    expect(ids({ status: 'failed' })).toEqual(['c']);
    expect(ids({ creative: false })).toEqual(['b']);
    expect(ids({ exportType: ExportType.Blooket })).toEqual(['d']);
  });

  it('combines every filter that is set', () => {
    expect(ids({
      creative: true,
      status: 'done',
      search: 'hsk'
    })).toEqual(['a']);
    expect(ids({
      creative: false,
      status: 'failed'
    })).toEqual([]);
  });
});

describe('filterJobs by lesson', () => {
  const jobs = [
    job({
      id: 'a',
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V2,
      level: 3,
      lessonNumber: 5
    }),
    job({
      id: 'b',
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 3,
      lessonNumber: 5
    }),
    job({
      id: 'c',
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 7,
      lessonNumber: 1
    }),
    job({
      id: 'd',
      courseType: CourseType.Yct,
      level: 1,
      lessonNumber: 5
    }),
    job({
      id: 'e',
      courseType: CourseType.Other,
      courseName: 'Boya',
      lessonNumber: 2
    }),
    job({
      id: 'f',
      creative: false,
      exportType: null
    }),
  ];
  const ids = (filter: Partial<AiJobFilter>) => filterJobs(jobs, { ...NO_FILTER, ...filter }).map(j => j.id);

  it('filters by course type, which leaves out jobs that have none', () => {
    expect(ids({ courseType: CourseType.Hsk })).toEqual(['a', 'b', 'c']);
    expect(ids({ courseType: CourseType.Yct })).toEqual(['d']);
    expect(ids({ courseType: CourseType.Other })).toEqual(['e']);
  });

  it('filters by HSK standard', () => {
    expect(ids({ hskStandard: HskStandard.V3 })).toEqual(['b', 'c']);
    expect(ids({ hskStandard: HskStandard.V2 })).toEqual(['a']);
  });

  it('filters by level and lesson number', () => {
    expect(ids({ level: 3 })).toEqual(['a', 'b']);
    expect(ids({ lessonNumber: 5 })).toEqual(['a', 'b', 'd']);
  });

  it('combines the lesson filters', () => {
    expect(ids({
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 3,
      lessonNumber: 5
    })).toEqual(['b']);
    expect(ids({
      courseType: CourseType.Yct,
      hskStandard: HskStandard.V3
    })).toEqual([]);
  });
});

describe('lessonLabel', () => {
  it('names the course, level and lesson', () => {
    expect(lessonLabel(job({
      courseType: CourseType.Hsk,
      hskStandard: HskStandard.V3,
      level: 4,
      lessonNumber: 5
    }))).toBe('HSK 3.0 · cấp 4 · bài 5');
    expect(lessonLabel(job({
      courseType: CourseType.Hsk,
      hskStandard: null,
      level: 1,
      lessonNumber: 2
    }))).toBe('HSK 2.0 · cấp 1 · bài 2');
    expect(lessonLabel(job({
      courseType: CourseType.Yct,
      level: 2,
      lessonNumber: 7
    }))).toBe('YCT · cấp 2 · bài 7');
  });

  it('uses the typed course name and skips a missing level', () => {
    expect(lessonLabel(job({
      courseType: CourseType.Other,
      courseName: 'Boya',
      lessonNumber: 3
    }))).toBe('Boya · bài 3');
  });

  it('has a dash for a job without a lesson', () => {
    expect(lessonLabel(job({
      creative: false,
      exportType: null
    }))).toBe('–');
  });
});
