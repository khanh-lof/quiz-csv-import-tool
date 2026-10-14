import { HttpErrorResponse } from '@angular/common/http';
import {
  Assignment,
  assignmentErrorMessage,
  AssignmentDetail,
  assignmentStatusText,
  formatClose,
  formatStamp,
  isOpenAt,
  RankedPlayer,
  rankingCsv,
  shareUrl,
  stageCountsOf,
  TIME_MODE_LABELS,
} from './assignment';
import { GestureQuiz } from './gesture-quiz';

// A time in the browser's own zone, as an RFC 3339 string: the formatting is local, so the specs build
// their times the same way and pass in any time zone.
function local(y: number, mo: number, d: number, h = 0, mi = 0): string {
  return new Date(y, mo - 1, d, h, mi).toISOString();
}

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: 'a1', code: 'K7M2X9QD4P', jobId: 'job-1', title: 'HSK1 bài 1', label: '', timeMode: 'standard', stageLock: 'sequential',
    stageCounts: {'1': 5, '2': 5}, createdAt: local(2026, 10, 14, 8), closesAt: null, closedAt: null,
    open: true, playerCount: 0, ...overrides,
  };
}

function player(overrides: Partial<RankedPlayer> = {}): RankedPlayer {
  return {
    id: 'p1', name: 'Lan', rank: 1, stagesPassed: 1, correct: 9, possible: 10, attempts: 2,
    stages: {'1': {correct: 5, total: 5, passed: true, attempts: 1}, '2': {correct: 4, total: 5, passed: false, attempts: 1}},
    joinedAt: local(2026, 10, 14, 8, 1), lastPlayedAt: local(2026, 10, 14, 8, 5), reachedAt: local(2026, 10, 14, 8, 5),
    ...overrides,
  };
}

function detail(players: RankedPlayer[], overrides: Partial<AssignmentDetail> = {}): AssignmentDetail {
  return {...assignment(), csv: '', players, ...overrides};
}

function quizWith(counts: Record<number, number>): GestureQuiz {
  return {
    title: 'Quiz',
    key: 'gq-1',
    stages: new Map(Object.entries(counts).map(([stage, count]) => [
      Number(stage),
      Array.from({length: count}, () => ({stage: Number(stage), question: 'Q', correct: 'A', wrong: [], explanation: ''})),
    ])),
    skipped: 0,
  };
}

describe('shareUrl', () => {
  it('puts the code after /play/s/ on the given origin', () => {
    expect(shareUrl('K7M2X9QD4P', 'https://quiz.example')).toBe('https://quiz.example/play/s/K7M2X9QD4P');
  });

  it('uses the current origin by default', () => {
    expect(shareUrl('K7M2X9QD4P')).toBe(`${location.origin}/play/s/K7M2X9QD4P`);
  });
});

describe('stageCountsOf', () => {
  it('lists only the stages that have questions, keyed by number', () => {
    expect(stageCountsOf(quizWith({1: 5, 2: 0, 4: 10, 6: 3}))).toEqual({'1': 5, '4': 10, '6': 3});
  });

  it('is empty for a quiz without questions', () => {
    expect(stageCountsOf(quizWith({}))).toEqual({});
  });
});

describe('isOpenAt', () => {
  const now = new Date(2026, 9, 14, 12, 0);

  it('is open without a closing time', () => {
    expect(isOpenAt(assignment(), now)).toBeTrue();
  });

  it('is open before the closing time and closed from it on', () => {
    const a = assignment({closesAt: local(2026, 10, 14, 12, 30)});
    expect(isOpenAt(a, now)).toBeTrue();
    expect(isOpenAt(a, new Date(2026, 9, 14, 12, 30))).toBeFalse();
    expect(isOpenAt(a, new Date(2026, 9, 14, 13, 0))).toBeFalse();
  });

  it('is closed once closed by hand, whatever the closing time says', () => {
    expect(isOpenAt(assignment({closedAt: local(2026, 10, 14, 11)}), now)).toBeFalse();
    expect(isOpenAt(assignment({closedAt: local(2026, 10, 14, 11), closesAt: local(2026, 10, 15, 11)}), now)).toBeFalse();
  });

  it('goes by the clock, not by the stale open flag', () => {
    expect(isOpenAt(assignment({open: true, closesAt: local(2026, 10, 14, 9)}), now)).toBeFalse();
    expect(isOpenAt(assignment({open: false, closesAt: local(2026, 10, 14, 15)}), now)).toBeTrue();
  });
});

describe('formatClose and formatStamp', () => {
  it('writes HH:mm dd/MM with zero padding', () => {
    expect(formatClose(local(2026, 3, 5, 7, 4))).toBe('07:04 05/03');
  });

  it('writes dd/MM/yyyy HH:mm with zero padding', () => {
    expect(formatStamp(local(2026, 3, 5, 7, 4))).toBe('05/03/2026 07:04');
  });

  it('takes a Date too', () => {
    expect(formatClose(new Date(2026, 11, 31, 23, 59))).toBe('23:59 31/12');
  });
});

describe('assignmentStatusText', () => {
  const now = new Date(2026, 9, 14, 12, 0);

  it('says closed for a closed assignment', () => {
    expect(assignmentStatusText(assignment({closedAt: local(2026, 10, 14, 11)}), now)).toBe('Đã đóng');
    expect(assignmentStatusText(assignment({closesAt: local(2026, 10, 14, 11)}), now)).toBe('Đã đóng');
  });

  it('gives the closing time of an open assignment that has one', () => {
    expect(assignmentStatusText(assignment({closesAt: local(2026, 10, 14, 21, 30)}), now))
      .toBe('Đang mở · đóng lúc 21:30 14/10');
  });

  it('just says open without a closing time', () => {
    expect(assignmentStatusText(assignment(), now)).toBe('Đang mở');
  });
});

describe('TIME_MODE_LABELS', () => {
  it('names the three time modes', () => {
    expect(TIME_MODE_LABELS).toEqual({
      standard: 'Bình thường',
      extra: 'Thêm thời gian (×1.5)',
      unlimited: 'Không giới hạn',
    });
  });
});

describe('rankingCsv', () => {
  // The line begins with `prefix`: the failure shows the beginning of the line, not just "false".
  function expectStart(line: string, prefix: string): void {
    expect(line.slice(0, prefix.length)).toBe(prefix);
  }

  function lines(csv: string): string[] {
    return csv.slice(1).split('\r\n');
  }

  it('starts with a BOM and ends every line with CRLF', () => {
    const csv = rankingCsv(detail([player()]));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.endsWith('\r\n')).toBeTrue();
    expect(csv).not.toMatch(/[^\r]\n/);
  });

  it('has a column per stage of the assignment, in order, headed with its position and its game', () => {
    const csv = rankingCsv(detail([], {stageCounts: {'4': 5, '1': 5, '6': 10}}));
    expect(lines(csv)[0]).toBe(
      'Hạng,Tên,Màn đã qua,Câu đúng,Màn 1 (Đúng hay sai),Màn 2 (Chém hoa quả),Màn 3 (Xếp câu),Lần chơi,Cập nhật');
  });

  it('numbers the stage columns by position, not by stage number', () => {
    const csv = rankingCsv(detail([player({stages: {'6': {correct: 4, total: 5, passed: true, attempts: 1}}})],
      {stageCounts: {'4': 5, '6': 5}}));
    const [header, row] = lines(csv);
    expect(header).toBe('Hạng,Tên,Màn đã qua,Câu đúng,Màn 1 (Chém hoa quả),Màn 2 (Xếp câu),Lần chơi,Cập nhật');
    // Stage 4 has no result, stage 6 is the second column.
    expectStart(row, '1,Lan,1/2,9/10,,4/5 ✓,');
  });

  it('writes one row per student, in the order given', () => {
    const csv = rankingCsv(detail([
      player({id: 'a', name: 'Lan', rank: 1}),
      player({id: 'b', name: 'Minh', rank: 2, stagesPassed: 0, correct: 3, attempts: 1}),
    ]));
    const rows = lines(csv);
    expect(rows[0]).toBe('Hạng,Tên,Màn đã qua,Câu đúng,Màn 1 (Đúng hay sai),Màn 2 (Nghiêng đầu),Lần chơi,Cập nhật');
    expect(rows[1]).toBe('1,Lan,1/2,9/10,5/5 ✓,4/5,2,14/10/2026 08:05');
    expectStart(rows[2], '2,Minh,0/2,3/10,');
    expect(rows[3]).toBe('');
    expect(rows.length).toBe(4);
  });

  it('leaves the rank, the stages and the time empty for a student who has not played', () => {
    const csv = rankingCsv(detail([
      player({name: 'Bảo', rank: null, stagesPassed: 0, correct: 0, attempts: 0, stages: {}, lastPlayedAt: null, reachedAt: null}),
    ]));
    expect(lines(csv)[1]).toBe(',Bảo,0/2,0/10,,,0,');
  });

  it('counts the stages the assignment has, not six', () => {
    const csv = rankingCsv(detail([player({stagesPassed: 3, correct: 40, possible: 45})], {stageCounts: {'1': 5, '3': 10, '5': 30}}));
    expectStart(lines(csv)[1], '1,Lan,3/3,40/45,');
  });

  it('quotes fields that contain a comma, a quote or a line break', () => {
    const csv = rankingCsv(detail([player({name: 'Lan, "Bé"\nNhỏ'})]));
    expect(csv).toContain('1,"Lan, ""Bé""\nNhỏ",1/2');
  });

  it('keeps a name that starts like a formula from running in a spreadsheet', () => {
    const csv = rankingCsv(detail([player({name: '=HYPERLINK("http://x")'}), player({name: '-Lan'}), player({name: 'Lan-2'})]));
    const rows = lines(csv);
    expectStart(rows[1], `1,"'=HYPERLINK(""http://x"")",`);
    expectStart(rows[2], `1,'-Lan,`);
    expectStart(rows[3], '1,Lan-2,');
  });
});

describe('assignmentErrorMessage', () => {
  const failure = (status: number, error: unknown = '') => new HttpErrorResponse({status, error});

  it('turns the plain-text answers of the server into advice', () => {
    expect(assignmentErrorMessage(failure(409, 'Too many assignments.'))).toContain('100 bài giao');
    expect(assignmentErrorMessage(failure(404, 'Job not found'))).toContain('Không tìm thấy quiz');
    expect(assignmentErrorMessage(failure(400, 'Invalid closing time.\n'))).toContain('tương lai');
  });

  it('explains a lost connection, an expired login and anything unknown', () => {
    expect(assignmentErrorMessage(failure(0))).toContain('Mất kết nối');
    expect(assignmentErrorMessage(failure(401))).toContain('đăng nhập');
    expect(assignmentErrorMessage(failure(400, 'Something else'))).toBe('Yêu cầu chưa hợp lệ.');
    expect(assignmentErrorMessage(failure(500))).toContain('thử lại');
    expect(assignmentErrorMessage(new Error('x'))).toContain('thử lại');
  });
});