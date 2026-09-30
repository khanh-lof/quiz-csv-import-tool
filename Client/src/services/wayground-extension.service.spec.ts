import { TestBed } from '@angular/core/testing';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { WaygroundExtensionService } from './wayground-extension.service';
import { FileExportService } from './file-export.service';
import { WaygroundDelivery } from '../models/wayground-delivery';

describe('WaygroundExtensionService', () => {
  let service: WaygroundExtensionService;
  let notifications: jasmine.SpyObj<NzNotificationService>;
  let sent: any[];
  let downloadXlsx: jasmine.Spy;

  beforeEach(() => {
    notifications = jasmine.createSpyObj('NzNotificationService', ['success', 'error']);
    TestBed.configureTestingModule({providers: [{provide: NzNotificationService, useValue: notifications}]});
    service = TestBed.inject(WaygroundExtensionService);
    downloadXlsx = spyOn(TestBed.inject(FileExportService), 'downloadXlsx');
    sent = [];
    spyOn(window, 'postMessage').and.callFake((message: any) => sent.push(message));
    spyOn(navigator.clipboard, 'writeText').and.resolveTo();
  });

  function reply(data: object): void {
    window.dispatchEvent(new MessageEvent('message', {data, source: window, origin: window.location.origin}));
  }

  it('sends the file as base64 with a request id', () => {
    service.sendImport('HSK1-Bai1', 'HSK1-Bai1-Wayground.xlsx', new Uint8Array([80, 75]));

    expect(sent[0]).toEqual(jasmine.objectContaining(
      {source: 'quiztool', type: 'wayground-import', title: 'HSK1-Bai1', base64: 'UEs='}));
    expect(sent[0].requestId).toBeTruthy();
  });

  it('shows and copies the share link of its own request', async () => {
    service.sendImport('HSK1-Bai1', 'f.xlsx', new Uint8Array([1]));
    const shareUrl = 'https://wayground.com/admin/assessment/abc?source=lesson_share';
    reply({source: 'quiztool-extension', type: 'wayground-import-result', requestId: sent[0].requestId,
      title: 'HSK1-Bai1', ok: true, shareUrl});
    await Promise.resolve();
    await Promise.resolve();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(shareUrl);
    expect(notifications.success).toHaveBeenCalledWith('Đã publish quiz trên Wayground',
      jasmine.stringContaining(`href="${shareUrl}"`), jasmine.anything());
  });

  it('ignores results for requests it did not send', () => {
    reply({source: 'quiztool-extension', type: 'wayground-import-result', requestId: 'other', ok: true,
      shareUrl: 'https://wayground.com/x'});

    expect(notifications.success).not.toHaveBeenCalled();
    expect(notifications.error).not.toHaveBeenCalled();
  });

  it('reports a failed publish and downloads the file for a manual import', () => {
    const xlsx = new Uint8Array([1]);
    service.sendImport('<b>x</b>', 'f.xlsx', xlsx);
    reply({source: 'quiztool-extension', type: 'wayground-import-result', requestId: sent[0].requestId,
      title: '<b>x</b>', ok: false, error: 'không bấm Publish được'});

    expect(downloadXlsx).toHaveBeenCalledWith('f.xlsx', xlsx);
    expect(notifications.error).toHaveBeenCalledWith('Wayground chưa publish được',
      jasmine.stringContaining('không bấm Publish được'), jasmine.anything());
  });

  it('does not download the file after a successful publish', async () => {
    service.sendImport('HSK1-Bai1', 'f.xlsx', new Uint8Array([1]));
    reply({source: 'quiztool-extension', type: 'wayground-import-result', requestId: sent[0].requestId,
      title: 'HSK1-Bai1', ok: true, shareUrl: 'https://wayground.com/x'});
    await Promise.resolve();

    expect(downloadXlsx).not.toHaveBeenCalled();
  });

  describe('delivery choice', () => {
    afterEach(() => {
      delete document.documentElement.dataset['quiztoolExtension'];
      localStorage.removeItem('wayground-delivery');
    });

    it('is always the download without the extension', () => {
      service.savePreferredDelivery(WaygroundDelivery.Extension);

      expect(service.preferredDelivery()).toBe(WaygroundDelivery.Download);
      expect(service.shouldPublish(WaygroundDelivery.Extension)).toBeFalse();
    });

    it('defaults to the extension once installed and remembers a download choice', () => {
      document.documentElement.dataset['quiztoolExtension'] = '0.1.0';
      localStorage.removeItem('wayground-delivery');
      expect(service.preferredDelivery()).toBe(WaygroundDelivery.Extension);

      service.savePreferredDelivery(WaygroundDelivery.Download);
      expect(service.preferredDelivery()).toBe(WaygroundDelivery.Download);
      expect(service.shouldPublish(WaygroundDelivery.Download)).toBeFalse();
      expect(service.shouldPublish(WaygroundDelivery.Extension)).toBeTrue();
    });
  });
});
