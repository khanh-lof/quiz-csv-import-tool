// How long a question lasts: the stage's own seconds, half as long again, or no timer at all.
export type TimeMode = 'standard' | 'extra' | 'unlimited';

export const TIME_MODES: readonly TimeMode[] = ['standard', 'extra', 'unlimited'];

export const TIME_MODE_LABELS: Record<TimeMode, string> = {
  standard: 'Chuẩn',
  extra: 'Thêm giờ (×1,5)',
  unlimited: 'Không giới hạn',
};
