import { Injectable } from '@angular/core';

// Talks to the optional QuizTool browser extension (`../Extension`), which imports a Wayground .xlsx
// in the user's own logged-in Wayground tab. The extension's content script marks the page with
// `data-quiztool-extension` and listens for the message below. Both shapes are hand-kept in step with
// `Extension/bridge.js`.
export const WAYGROUND_IMPORT_MESSAGE = 'wayground-import';

export interface WaygroundImportMessage {
  source: 'quiztool';
  type: typeof WAYGROUND_IMPORT_MESSAGE;
  title: string;
  fileName: string;
  base64: string;
}

@Injectable({
  providedIn: 'root',
})
export class WaygroundExtensionService {
  public isInstalled(): boolean {
    return !!document.documentElement.dataset['quiztoolExtension'];
  }

  // Hands the file to the extension, which opens a Wayground tab and imports it there.
  public sendImport(title: string, fileName: string, xlsx: Uint8Array): void {
    const message: WaygroundImportMessage = {
      source: 'quiztool',
      type: WAYGROUND_IMPORT_MESSAGE,
      title,
      fileName,
      base64: WaygroundExtensionService.toBase64(xlsx),
    };
    window.postMessage(message, window.location.origin);
  }

  // Chunked, since String.fromCharCode(...bytes) overflows the call stack on a large file.
  private static toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }
}
