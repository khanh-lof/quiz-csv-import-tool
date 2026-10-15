import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { MarqueeSettings } from '../marquee-settings.service';
import { MarqueePauseButton } from './marquee-pause-button';

const KEY = 'leaderboard-marquee-paused';

describe('MarqueePauseButton', () => {
  let fixture: ComponentFixture<MarqueePauseButton>;
  let settings: MarqueeSettings;

  beforeEach(async () => {
    localStorage.removeItem(KEY);
    await TestBed.configureTestingModule({imports: [MarqueePauseButton]}).compileComponents();
    settings = TestBed.inject(MarqueeSettings);
    fixture = TestBed.createComponent(MarqueePauseButton);
    fixture.detectChanges();
  });

  afterEach(() => localStorage.removeItem(KEY));

  const button = () => (fixture.nativeElement as HTMLElement).querySelector('button')!;
  const icon = () => button().querySelector('nz-icon')!;
  const iconType = () => fixture.debugElement.query(By.directive(NzIconDirective)).injector.get(NzIconDirective).nzType();

  function setCompact(compact: boolean): void {
    fixture.componentRef.setInput('compact', compact);
    fixture.detectChanges();
  }

  it('is a small plain button that offers to stop the names while they run', () => {
    expect(button().type).toBe('button');
    expect(button().textContent?.trim()).toBe('Dừng chữ chạy');
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(iconType()).toBe('pause-circle');
    expect(button().classList).toContain('ant-btn-sm');
  });

  it('toggles the settings on a click and offers to start them again', () => {
    button().click();
    fixture.detectChanges();

    expect(settings.paused()).toBeTrue();
    expect(button().textContent?.trim()).toBe('Cho chữ chạy');
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(iconType()).toBe('play-circle');

    button().click();
    fixture.detectChanges();

    expect(settings.paused()).toBeFalse();
    expect(button().textContent?.trim()).toBe('Dừng chữ chạy');
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('follows a change made elsewhere', () => {
    settings.setPaused(true);
    fixture.detectChanges();

    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(button().textContent?.trim()).toBe('Cho chữ chạy');
  });

  it('has no aria-label or title when it shows its text', () => {
    expect(button().hasAttribute('aria-label')).toBeFalse();
    expect(button().hasAttribute('title')).toBeFalse();
  });

  it('shows only the icon when compact, and puts the words in the label and the title', () => {
    setCompact(true);

    expect(button().textContent?.trim()).toBe('');
    expect(icon()).not.toBeNull();
    expect(button().getAttribute('aria-label')).toBe('Dừng chữ chạy');
    expect(button().getAttribute('title')).toBe('Dừng chữ chạy');

    button().click();
    fixture.detectChanges();

    expect(button().getAttribute('aria-label')).toBe('Cho chữ chạy');
    expect(button().getAttribute('title')).toBe('Cho chữ chạy');
    expect(button().getAttribute('aria-pressed')).toBe('true');
  });
});
