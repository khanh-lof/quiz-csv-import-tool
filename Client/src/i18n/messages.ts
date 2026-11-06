import { inject, Injectable, Pipe, PipeTransform } from '@angular/core';
import { NzI18nService } from 'ng-zorro-antd/i18n';
import { MESSAGES_PATH } from './app-locale';
import { viMessages } from './vi-messages';

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<typeof viMessages>;
export type MessageParams = Record<string, string | number>;

@Injectable({ providedIn: 'root' })
export class Messages {
  private readonly i18n = inject(NzI18nService);

  get(key: MessageKey, params?: MessageParams): string {
    return this.i18n.translate(`${MESSAGES_PATH}.${key}`, params);
  }
}

@Pipe({ name: 'msg' })
export class MessagePipe implements PipeTransform {
  private readonly messages = inject(Messages);

  transform(key: MessageKey, params?: MessageParams): string {
    return this.messages.get(key, params);
  }
}
