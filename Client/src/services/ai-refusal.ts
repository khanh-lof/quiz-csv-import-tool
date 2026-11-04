import { HttpStatusCode } from '@angular/common/http';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { HttpFailure } from '../models/http-failure';

// The refusals every AI request can get: the rate limit and the role check (both 403, told apart by the body)
// and a lost connection. Returns whether the failure was one of them.
export function notifyAiRefusal(notifications: NzNotificationService, { status, body }: HttpFailure): boolean {
  if (status === HttpStatusCode.Forbidden && body) {
    notifications.warning('Hết lượt dùng AI', 'Thử lại sau ít phút.', { nzDuration: 0 });
  } else if (status === HttpStatusCode.Forbidden) {
    notifications.error('Không có quyền', 'Chưa được dùng AI.');
  } else if (status === 0) {
    notifications.error('Mất kết nối', 'Kiểm tra mạng rồi thử lại.');
  } else {
    return false;
  }
  return true;
}
