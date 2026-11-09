import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { PublishDelivery } from '../models/publish-delivery';
import { ExportType } from '../models/export-type';
import { FileExportService } from './file-export.service';
import { escapeHtml } from './escape-html';
import { Messages } from '../i18n/messages';

// The user's last choice between downloading the platform's file and letting the extension publish it,
// shared by the table and the AI page and by every platform the extension can publish to.
const DELIVERY_STORAGE_KEY = 'wayground-delivery';
const EXTENSION_ZIP_URL = '/api/extension';
const EXTENSION_ZIP_NAME = 'quiztool-extension.zip';

// The platforms the extension can create a quiz on, and what each is called to the user.
export type PublishPlatform = 'wayground' | 'gimkit';
const PLATFORM_NAMES: Record<PublishPlatform, string> = { wayground: 'Wayground', gimkit: 'Gimkit' };

// Talks to the optional QuizTool browser extension (`../Extension`), which creates and publishes the
// quiz in the user's own logged-in Wayground or Gimkit tab and reports the quiz's share link back. The
// extension's content script marks the page with `data-quiztool-extension` and listens for the
// request below, then posts a result back. Both shapes are hand-kept in step with `Extension/bridge.js`.
// The type is `<platform>-import`, and its file is an .xlsx for Wayground and a .csv for Gimkit.
export interface PublishImportMessage {
  source: 'quiztool';
  type: `${PublishPlatform}-import`;
  requestId: string;
  title: string;
  fileName: string;
  base64: string;
}

export interface PublishImportResult {
  source: 'quiztool-extension';
  type: `${PublishPlatform}-import-result`;
  requestId: string;
  title: string;
  ok: boolean;
  shareUrl?: string;
  error?: string;
}

@Injectable({
  providedIn: 'root',
})
export class PublishExtensionService {
  // Requests this page sent, so results meant for another QuizTool tab are ignored. Each keeps its file,
  // which is downloaded if the extension fails so the user can import it by hand.
  private readonly messages = inject(Messages);
  private readonly pendingRequests = new Map<string, { platform: PublishPlatform, fileName: string, bytes: Uint8Array }>();

  constructor(private readonly notificationService: NzNotificationService,
              private readonly fileExportService: FileExportService,
              private readonly httpClient: HttpClient) {
    window.addEventListener('message', event => this.onMessage(event));
  }

  // The platform the extension publishes this export type to, or null when it cannot (Blooket, the games).
  public static platformFor(exportType: ExportType | null | undefined): PublishPlatform | null {
    switch (exportType) {
      case ExportType.Wayground:
        return 'wayground';
      case ExportType.GimKit:
        return 'gimkit';
      default:
        return null;
    }
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
      error: () => this.notificationService.error(this.messages.get('app.publish.extensionDownloadFailed'), this.messages.get('common.tryAgain')),
    });
  }

  // The bridge script runs at document_start, so this is already true when the first component renders.
  public isInstalled(): boolean {
    return !!document.documentElement.dataset['quiztoolExtension'];
  }

  // The extension when it is installed, unless the user last chose to download the file.
  public preferredDelivery(): PublishDelivery {
    if (!this.isInstalled()) return PublishDelivery.Download;
    try {
      return localStorage.getItem(DELIVERY_STORAGE_KEY) === PublishDelivery.Download
        ? PublishDelivery.Download : PublishDelivery.Extension;
    } catch {
      return PublishDelivery.Extension;
    }
  }

  public savePreferredDelivery(delivery: PublishDelivery): void {
    try {
      localStorage.setItem(DELIVERY_STORAGE_KEY, delivery);
    } catch {
      // Remembering the choice is only a convenience.
    }
  }

  public shouldPublish(delivery: PublishDelivery): boolean {
    return delivery === PublishDelivery.Extension && this.isInstalled();
  }

  // Hands the file to the extension, which opens a tab on the platform, publishes the quiz there and
  // closes the tab again. The outcome arrives later and is shown as its own notification.
  public sendImport(platform: PublishPlatform, title: string, fileName: string, bytes: Uint8Array): void {
    const requestId = crypto.randomUUID();
    this.pendingRequests.set(requestId, {
      platform,
      fileName,
      bytes
    });
    const message: PublishImportMessage = {
      source: 'quiztool',
      type: `${platform}-import`,
      requestId,
      title,
      fileName,
      base64: PublishExtensionService.toBase64(bytes),
    };
    window.postMessage(message, window.location.origin);
  }

  // Tells the user the extension has started, with the platform's name.
  public notifyStarted(platform: PublishPlatform): void {
    this.notificationService.info(
      this.messages.get('common.creatingOnPlatform', { platform: PLATFORM_NAMES[platform] }),
      this.messages.get('common.publishLinkHint'));
  }

  private onMessage(event: MessageEvent): void {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const result = event.data as PublishImportResult;
    if (result?.source !== 'quiztool-extension' || !/^(wayground|gimkit)-import-result$/.test(result.type)) return;
    const file = this.pendingRequests.get(result.requestId);
    if (!file) return;
    this.pendingRequests.delete(result.requestId);

    if (!result.ok || !result.shareUrl) {
      // The file was not downloaded when the extension took it, so fetch it now for the manual import.
      this.downloadForManualImport(file);
      this.notificationService.error(
        this.messages.get('app.publish.publishFailed', { platform: PLATFORM_NAMES[file.platform] }),
        this.messages.get('app.publish.downloadedImportManually', { fileName: escapeHtml(file.fileName) }), { nzDuration: 0 });
      return;
    }
    // The tab is focused again (the extension closed the platform's tab), so the copy usually works;
    // the link is in the notification either way.
    navigator.clipboard?.writeText(result.shareUrl).then(
      () => this.showPublished(file.platform, result, true),
      () => this.showPublished(file.platform, result, false));
  }

  private downloadForManualImport(file: { platform: PublishPlatform, fileName: string, bytes: Uint8Array }): void {
    if (file.platform === 'wayground') {
      this.fileExportService.downloadXlsx(file.fileName, file.bytes);
    } else {
      this.fileExportService.downloadBlob(file.fileName, new Blob([file.bytes as BlobPart], { type: 'text/csv;charset=utf-8' }));
    }
  }

  private showPublished(platform: PublishPlatform, result: PublishImportResult, copied: boolean): void {
    const url = escapeHtml(result.shareUrl!);
    this.notificationService.success(
      this.messages.get('app.publish.published', { platform: PLATFORM_NAMES[platform] }),
      this.messages.get('app.publish.publishedBody', {
        title: escapeHtml(result.title),
        copied: copied ? this.messages.get('app.publish.copiedSuffix') : '',
        link: `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
      }), { nzDuration: 0 });
  }
}
