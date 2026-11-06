import { HttpStatusCode } from '@angular/common/http';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { HttpFailure } from '../models/http-failure';
import { Messages } from '../i18n/messages';

// The refusals every AI request can get: the rate limit and the role check (both 403, told apart by the body)
// and a lost connection. Returns whether the failure was one of them.
export function notifyAiRefusal(notifications: NzNotificationService, messages: Messages,
                                { status, body }: HttpFailure): boolean {
  if (status === HttpStatusCode.Forbidden && body) {
    notifications.warning(messages.get('ai.refusal.quotaTitle'), messages.get('ai.retryLater'), { nzDuration: 0 });
  } else if (status === HttpStatusCode.Forbidden) {
    notifications.error(messages.get('ai.refusal.forbiddenTitle'), messages.get('ai.refusal.forbiddenBody'));
  } else if (status === 0) {
    notifications.error(messages.get('ai.refusal.offlineTitle'), messages.get('common.checkNetwork'));
  } else {
    return false;
  }
  return true;
}
