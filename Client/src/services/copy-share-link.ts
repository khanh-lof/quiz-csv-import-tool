import { NzNotificationService } from 'ng-zorro-antd/notification';
import { shareUrl } from '../models/assignment';

// Copies the link of an assignment and says so. When the clipboard is not available (an insecure page, or the
// browser said no) the notification says where to take the link from by hand, `fallbackHint`, and the result
// is false so the caller can put the link in front of the teacher.
export async function copyShareLink(notifications: NzNotificationService, code: string, fallbackHint: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(shareUrl(code));
  } catch {
    notifications.warning('Chưa sao chép được', fallbackHint);
    return false;
  }
  notifications.success('Đã sao chép link', '');
  return true;
}
