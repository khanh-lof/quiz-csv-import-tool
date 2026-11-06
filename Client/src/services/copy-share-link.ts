import { NzNotificationService } from 'ng-zorro-antd/notification';
import { Messages } from '../i18n/messages';
import { shareUrl } from '../models/assignment';

// Copies the link of an assignment and says so. When the clipboard is not available (an insecure page, or the
// browser said no) the notification says where to take the link from by hand, `fallbackHint`, and the result
// is false so the caller can put the link in front of the teacher.
export async function copyShareLink(
  notifications: NzNotificationService,
  messages: Messages,
  code: string,
  fallbackHint: string,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(shareUrl(code));
  } catch {
    notifications.warning(messages.get('assignments.share.copyFailed'), fallbackHint);
    return false;
  }
  notifications.success(messages.get('assignments.share.copied'), '');
  return true;
}
