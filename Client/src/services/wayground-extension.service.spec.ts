import { TestBed } from '@angular/core/testing';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { WaygroundExtensionService } from './wayground-extension.service';

describe('WaygroundExtensionService', () => {
  let service: WaygroundExtensionService;
  let notifications: jasmine.SpyObj<NzNotificationService>;
  let sent: any[];

  beforeEach(() => {
    notifications = jasmine.createSpyObj('NzNotificationService', ['success', 'error']);
    TestBed.configureTestingModule({providers: [{provide: NzNotificationService, useValue: notifications}]});
    service = TestBed.inject(WaygroundExtensionService);
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

  it('reports a failed publish', () => {
    service.sendImport('<b>x</b>', 'f.xlsx', new Uint8Array([1]));
    reply({source: 'quiztool-extension', type: 'wayground-import-result', requestId: sent[0].requestId,
      title: '<b>x</b>', ok: false, error: 'không bấm Publish được'});

    expect(notifications.error).toHaveBeenCalledWith('Wayground chưa publish được',
      jasmine.stringContaining('không bấm Publish được'), jasmine.anything());
  });
});
