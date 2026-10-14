import { CourseType } from './course-type';
import { HskStandard } from './hsk-standard';
import { TEXTBOOKS, textbookFor } from './textbook';

describe('textbookFor', () => {
  it('finds the HSK 3.0 books by level', () => {
    expect(textbookFor(CourseType.Hsk, HskStandard.V3, 1)?.lessons).toBe(15);
    expect(textbookFor(CourseType.Hsk, HskStandard.V3, 2)?.lessons).toBe(15);
    expect(textbookFor(CourseType.Hsk, HskStandard.V3, 3)).toEqual(jasmine.objectContaining({lessons: 18, title: '《新HSK教程3》'}));
  });

  it('finds the YCT book whatever the HSK standard says', () => {
    expect(textbookFor(CourseType.Yct, null, 6)?.lessons).toBe(15);
    expect(textbookFor(CourseType.Yct, HskStandard.V2, 6)?.title).toBe('《YCT标准教程6》');
  });

  it('has no book for HSK 2.0, even at a level the HSK 3.0 books cover', () => {
    expect(textbookFor(CourseType.Hsk, HskStandard.V2, 2)).toBeUndefined();
    expect(textbookFor(CourseType.Hsk, null, 2)).toBeUndefined();
  });

  it('has no book for a level without one', () => {
    expect(textbookFor(CourseType.Hsk, HskStandard.V3, 4)).toBeUndefined();
    expect(textbookFor(CourseType.Yct, null, 5)).toBeUndefined();
  });

  it('has no book for a course typed in by hand', () => {
    expect(textbookFor(CourseType.Other, HskStandard.V3, 1)).toBeUndefined();
    expect(textbookFor(CourseType.Other, null, 6)).toBeUndefined();
  });

  it('has no book without a course type or a level', () => {
    expect(textbookFor(CourseType.Hsk, HskStandard.V3, null)).toBeUndefined();
    expect(textbookFor(CourseType.Yct, null, null)).toBeUndefined();
    expect(textbookFor(null, HskStandard.V3, 1)).toBeUndefined();
  });

  it('lists each book once', () => {
    const keys = TEXTBOOKS.map(b => `${b.courseType}/${b.hskStandard ?? ''}/${b.level}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
