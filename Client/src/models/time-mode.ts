import { MessageKey } from '../i18n/messages';
import { viMessages } from '../i18n/vi-messages';

// How long a question lasts: the stage's own seconds, half as long again, or no timer at all.
export type TimeMode = 'standard' | 'extra' | 'unlimited';

export const TIME_MODES: readonly TimeMode[] = ['standard', 'extra', 'unlimited'];

export const TIME_MODE_KEYS: Record<TimeMode, MessageKey> = {
  standard: 'assignments.timeMode.standard',
  extra: 'assignments.timeMode.extra',
  unlimited: 'assignments.timeMode.unlimited',
};

export const TIME_MODE_LABELS: Record<TimeMode, string> = viMessages.assignments.timeMode;
