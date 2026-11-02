import { reviewLines } from './radicals-play';

describe('reviewLines', () => {
  it('writes one line per kind of item and leaves the empty kinds out', () => {
    const lines = reviewLines({
      aiWords: ['借', '还'],
      uncertainWords: [],
      droppedWords: null,
      aiChars: ['借'],
      aiComponents: null,
      pinyinWarnings: [{ lesson: 1, word: '还', char: '还', syllable: 'hǎi', readings: ['hái', 'huán'] }],
      skippedLessons: [{ lesson: 2, usableWordCount: 4, unusableWords: ['一'] }],
      missingGlyphs: [],
    });
    expect(lines.map(line => line.label)).toEqual([
      'Pinyin, nghĩa do AI điền', 'Pinyin cần xem (bài 1)', 'Bài 2 bị bỏ', 'Nghĩa chữ do AI viết'
    ]);
    expect(lines[0].text).toBe('借, 还');
    expect(lines[1].text).toContain('hái / huán');
  });
});
