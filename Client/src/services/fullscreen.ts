import { NzNotificationService } from 'ng-zorro-antd/notification';

// Full-screens `element`, or leaves full screen when something already is.
export function toggleFullscreen(
  element: HTMLElement | undefined,
  notifications: NzNotificationService,
  failedMessage: string,
): void {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => undefined);
    return;
  }
  const failed = () => notifications.warning(failedMessage, '');
  try {
    element?.requestFullscreen().catch(failed);
  } catch {
    failed();
  }
}
