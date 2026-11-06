import { NzModalService } from 'ng-zorro-antd/modal';
import { Messages } from '../i18n/messages';

interface DeleteConfirmation {
  title: string;
  content?: string;
  onOk: () => void;
}

// A red "Xóa" confirmation for something that cannot be taken back.
export function confirmDelete(modals: NzModalService, messages: Messages, { title, content, onOk }: DeleteConfirmation): void {
  modals.confirm({
    nzTitle: title,
    nzContent: content,
    nzOkText: messages.get('assignments.action.delete'),
    nzOkDanger: true,
    nzClassName: 'qt-confirm-danger',
    nzIconType: 'delete',
    nzCancelText: messages.get('assignments.confirmDelete.keep'),
    nzCentered: true,
    nzOnOk: onOk,
  });
}
