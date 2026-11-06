import { NzI18nInterface, vi_VN } from 'ng-zorro-antd/i18n';
import { viMessages } from './vi-messages';

export const MESSAGES_PATH = 'App';

export const appLocale = { ...vi_VN, [MESSAGES_PATH]: viMessages } as NzI18nInterface;
