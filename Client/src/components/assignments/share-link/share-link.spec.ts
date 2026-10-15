import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { shareUrl } from '../../../models/assignment';
import { ShareLink } from './share-link';

const CODE = 'K7M2X9QD4P';

describe('ShareLink', () => {
  let fixture: ComponentFixture<ShareLink>;
  let notifications: jasmine.SpyObj<NzNotificationService>;
  let writeText: jasmine.Spy;

  beforeEach(async () => {
    notifications = jasmine.createSpyObj('NzNotificationService', ['success', 'warning']);
    await TestBed.configureTestingModule({
      imports: [ShareLink],
      providers: [{
        provide: NzNotificationService,
        useValue: notifications
      }],
    }).compileComponents();
    writeText = jasmine.createSpy('writeText').and.resolveTo();
    spyOnProperty(navigator, 'clipboard', 'get').and.returnValue({ writeText } as unknown as Clipboard);
    fixture = TestBed.createComponent(ShareLink);
    fixture.componentRef.setInput('code', CODE);
    fixture.detectChanges();
  });

  const root = () => fixture.nativeElement as HTMLElement;
  const input = () => root().querySelector('input')!;
  const copyButton = () => root().querySelector('button')!;

  it('shows the whole link in a read-only field, and the code', () => {
    expect(input().value).toBe(shareUrl(CODE));
    expect(input().readOnly).toBeTrue();
    expect(root().querySelector('.code')?.textContent).toContain(`Mã bài: ${CODE}`);
  });

  it('draws a QR code of the link', () => {
    const qr = root().querySelector('nz-qrcode');
    expect(qr).not.toBeNull();
    expect(qr!.querySelector('svg, canvas')).not.toBeNull();
  });

  it('follows the code it is given', () => {
    fixture.componentRef.setInput('code', 'ABCDEFGHJK');
    fixture.detectChanges();

    expect(input().value).toBe(shareUrl('ABCDEFGHJK'));
    expect(root().querySelector('.code')?.textContent).toContain('ABCDEFGHJK');
  });

  it('copies the link and says so', async () => {
    copyButton().click();
    await fixture.whenStable();

    expect(writeText).toHaveBeenCalledOnceWith(shareUrl(CODE));
    expect(notifications.success).toHaveBeenCalledTimes(1);
    expect(notifications.success.calls.mostRecent().args[0]).toBe('Đã sao chép link');
    expect(notifications.warning).not.toHaveBeenCalled();
  });

  it('selects the link and asks for a hand copy when the clipboard refuses', async () => {
    writeText.and.rejectWith(new DOMException('denied', 'NotAllowedError'));
    document.body.appendChild(root());
    try {
      copyButton().click();
      await fixture.whenStable();

      expect(notifications.success).not.toHaveBeenCalled();
      expect(notifications.warning).toHaveBeenCalledTimes(1);
      expect(input().selectionStart).toBe(0);
      expect(input().selectionEnd).toBe(input().value.length);
    } finally {
      root().remove();
    }
  });
});
