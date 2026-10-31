import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { WaygroundDelivery } from '../models/wayground-delivery';
import { FileExportService } from './file-export.service';
import { escapeHtml } from './escape-html';

// The user's last choice between downloading the Wayground file and letting the extension publish it,
// shared by the table and the AI page.
const DELIVERY_STORAGE_KEY = 'wayground-delivery';
const EXTENSION_ZIP_URL = '/api/extension';
const EXTENSION_ZIP_NAME = 'quiztool-wayground-extension.zip';

// Talks to the optional QuizTool browser extension (`../Extension`), which creates and publishes the
// quiz in the user's own logged-in Wayground tab and reports the quiz's share link back. The
// extension's content script marks the page with `data-quiztool-extension` and listens for the
// request below, then posts a result back. Both shapes are hand-kept in step with `Extension/bridge.js`.
export interface WaygroundImportMessage {
  source: 'quiztool';
  type: 'wayground-import';
  requestId: string;
  title: string;
  fileName: string;
  base64: string;
}

export interface WaygroundImportResult {
  source: 'quiztool-extension';
  type: 'wayground-import-result';
  requestId: string;
  title: string;
  ok: boolean;
  shareUrl?: string;
  error?: string;
}

@Injectable({
  providedIn: 'root',
})
export class WaygroundExtensionService {
  // Requests this page sent, so results meant for another QuizTool tab are ignored. Each keeps its file,
  // which is downloaded if the extension fails so the user can import it by hand.
  private readonly pendingRequests = new Map<string, { fileName: string, xlsx: Uint8Array }>();

  constructor(private readonly notificationService: NzNotificationService,
              private readonly fileExportService: FileExportService,
              private readonly httpClient: HttpClient) {
    window.addEventListener('message', event => this.onMessage(event));
  }

  // Chunked, since String.fromCharCode(...bytes) overflows the call stack on a large file.
  private static toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  // The server serves the extension's zip to logged-in users only, so it is fetched with the token, not linked.
  public downloadExtension(): void {
    this.httpClient.get(EXTENSION_ZIP_URL, { responseType: 'blob' }).subscribe({
      next: zip => this.fileExportService.downloadBlob(EXTENSION_ZIP_NAME, zip),
      error: () => this.notificationService.error('Không tải được tiện ích', 'Thử lại.',
        { nzPlacement: 'top' }),
    });
  }

  // The bridge script runs at document_start, so this is already true when the first component renders.
  public isInstalled(): boolean {
    return !!document.documentElement.dataset['quiztoolExtension'];
  }

  // The extension when it is installed, unless the user last chose to download the file.
  public preferredDelivery(): WaygroundDelivery {
    if (!this.isInstalled()) return WaygroundDelivery.Download;
    try {
      return localStorage.getItem(DELIVERY_STORAGE_KEY) === WaygroundDelivery.Download
        ? WaygroundDelivery.Download : WaygroundDelivery.Extension;
    } catch {
      return WaygroundDelivery.Extension;
    }
  }

  // Hands the file to the extension, which opens a Wayground tab, publishes the quiz there and

  public savePreferredDelivery(delivery: WaygroundDelivery): void {
    try {
      localStorage.setItem(DELIVERY_STORAGE_KEY, delivery);
    } catch {
      // Remembering the choice is only a convenience.
    }
  }

  public shouldPublish(delivery: WaygroundDelivery): boolean {
    return delivery === WaygroundDelivery.Extension && this.isInstalled();
  }

  // closes the tab again. The outcome arrives later and is shown as its own notification.
  public sendImport(title: string, fileName: string, xlsx: Uint8Array): void {
    const requestId = crypto.randomUUID();
    this.pendingRequests.set(requestId, {
      fileName,
      xlsx
    });
    const message: WaygroundImportMessage = {
      source: 'quiztool',
      type: 'wayground-import',
      requestId,
      title,
      fileName,
      base64: WaygroundExtensionService.toBase64(xlsx),
    };
    window.postMessage(message, window.location.origin);
  }

  private onMessage(event: MessageEvent): void {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const result = event.data as WaygroundImportResult;
    if (result?.source !== 'quiztool-extension' || result.type !== 'wayground-import-result') return;
    const file = this.pendingRequests.get(result.requestId);
    if (!file) return;
    this.pendingRequests.delete(result.requestId);

    if (!result.ok || !result.shareUrl) {
      // The file was not downloaded when the extension took it, so fetch it now for the manual import.
      this.fileExportService.downloadXlsx(file.fileName, file.xlsx);
      this.notificationService.error('Wayground chưa publish được',
        `Tiện ích dừng lại (${escapeHtml(result.error ?? 'không rõ lỗi')}). ` +
        `Đã tải ${escapeHtml(file.fileName)}, import bằng tay.`,
        {
          nzPlacement: 'top',
          nzDuration: 0
        });
      return;
    }
    // The tab is focused again (the extension closed the Wayground tab), so the copy usually works;
    // the link is in the notification either way.
    navigator.clipboard?.writeText(result.shareUrl).then(
      () => this.showPublished(result, true),
      () => this.showPublished(result, false));
  }

  private showPublished(result: WaygroundImportResult, copied: boolean): void {
    const url = escapeHtml(result.shareUrl!);
    this.notificationService.success('Đã publish quiz trên Wayground',
      `"${escapeHtml(result.title)}"${copied ? ' (đã sao chép)' : ''}: ` +
      `<a href="${url}" target="_blank" rel="noopener">${url}</a>`,
      {
        nzPlacement: 'top',
        nzDuration: 0
      });
  }
}
