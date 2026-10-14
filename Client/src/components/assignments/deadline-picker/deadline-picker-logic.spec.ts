import { deadlineFromPreset, fromLocalInputValue, toLocalInputValue } from './deadline-picker-logic';

describe('deadlineFromPreset', () => {
  const now = new Date(2026, 9, 14, 10, 20, 35, 500);

  it('has no closing time for none, whatever was picked', () => {
    expect(deadlineFromPreset('none', now, new Date(2026, 9, 20))).toBeNull();
  });

  it('is 45 minutes from now', () => {
    expect(deadlineFromPreset('45m', now, null)).toEqual(new Date(2026, 9, 14, 11, 5, 35, 500));
  });

  it('crosses midnight for 45 minutes late in the evening', () => {
    expect(deadlineFromPreset('45m', new Date(2026, 9, 14, 23, 30), null)).toEqual(new Date(2026, 9, 15, 0, 15));
  });

  it('is 23:59 today', () => {
    expect(deadlineFromPreset('today', now, null)).toEqual(new Date(2026, 9, 14, 23, 59, 0, 0));
  });

  it('is still today with exactly 10 minutes left', () => {
    expect(deadlineFromPreset('today', new Date(2026, 9, 14, 23, 49), null)).toEqual(new Date(2026, 9, 14, 23, 59));
  });

  it('is 23:59 tomorrow with less than 10 minutes left today', () => {
    expect(deadlineFromPreset('today', new Date(2026, 9, 14, 23, 50), null)).toEqual(new Date(2026, 9, 15, 23, 59));
    expect(deadlineFromPreset('today', new Date(2026, 9, 14, 23, 59, 30), null)).toEqual(new Date(2026, 9, 15, 23, 59));
  });

  it('rolls over the end of a month', () => {
    expect(deadlineFromPreset('today', new Date(2026, 9, 31, 23, 55), null)).toEqual(new Date(2026, 10, 1, 23, 59));
  });

  it('is what was picked for custom', () => {
    const picked = new Date(2026, 9, 20, 8, 0);
    expect(deadlineFromPreset('custom', now, picked)).toBe(picked);
    expect(deadlineFromPreset('custom', now, null)).toBeNull();
  });
});

describe('datetime-local values', () => {
  it('writes the local date and time with zero padding', () => {
    expect(toLocalInputValue(new Date(2026, 2, 5, 7, 4, 59))).toBe('2026-03-05T07:04');
    expect(toLocalInputValue(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31T23:59');
  });

  it('reads them back as local time', () => {
    expect(fromLocalInputValue('2026-03-05T07:04')).toEqual(new Date(2026, 2, 5, 7, 4));
  });

  it('reads a value with seconds', () => {
    expect(fromLocalInputValue('2026-03-05T07:04:30')).toEqual(new Date(2026, 2, 5, 7, 4, 30));
  });

  it('round-trips', () => {
    const date = new Date(2026, 9, 14, 21, 30);
    expect(fromLocalInputValue(toLocalInputValue(date))).toEqual(date);
  });

  it('gives null for an empty, incomplete or impossible value', () => {
    expect(fromLocalInputValue('')).toBeNull();
    expect(fromLocalInputValue('2026-03-05')).toBeNull();
    expect(fromLocalInputValue('not a date')).toBeNull();
    expect(fromLocalInputValue('2026-02-31T10:00')).toBeNull();
    expect(fromLocalInputValue('2026-13-01T10:00')).toBeNull();
    expect(fromLocalInputValue('2026-03-05T25:00')).toBeNull();
  });
});
