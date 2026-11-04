import { NzModalService } from 'ng-zorro-antd/modal';

interface DeleteConfirmation {
  title: string;
  content?: string;
  onOk: () => void;
}

// A red "Xóa" confirmation for something that cannot be taken back.
export function confirmDelete(modals: NzModalService, { title, content, onOk }: DeleteConfirmation): void {
  modals.confirm({
    nzTitle: title,
    nzContent: content,
    nzOkText: 'Xóa',
    nzOkDanger: true,
    nzClassName: 'qt-confirm-danger',
    nzIconType: 'delete',
    nzCancelText: 'Giữ lại',
    nzCentered: true,
    nzOnOk: onOk,
  });
}
