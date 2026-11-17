import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNzI18n } from 'ng-zorro-antd/i18n';
import { appLocale } from '../../i18n/app-locale';
import { RotatePrompt, ScreenOrientationWanted } from './rotate-prompt';

describe('RotatePrompt', () => {
  let fixture: ComponentFixture<RotatePrompt>;
  let queries: string[];

  function fakeMedia(matching: string): void {
    queries = [];
    spyOn(window, 'matchMedia').and.callFake((query: string) => {
      queries.push(query);
      return {
        matches: query.includes(matching),
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      } as unknown as MediaQueryList;
    });
  }

  function create(to: ScreenOrientationWanted, canLock: boolean, target?: HTMLElement): HTMLElement {
    fixture = TestBed.createComponent(RotatePrompt);
    (fixture.componentInstance as unknown as { canLock: boolean }).canLock = canLock;
    fixture.componentRef.setInput('to', to);
    fixture.componentRef.setInput('fullscreenTarget', target);
    fixture.detectChanges();
    return fixture.nativeElement;
  }

  beforeEach(() => TestBed.configureTestingModule({ providers: [provideNzI18n(appLocale)] }));

  const normalized = (element: HTMLElement): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('asks a phone held upright to turn on its side, as text where the browser cannot turn it', () => {
    fakeMedia('(orientation: portrait)');
    const element = create('landscape', false);

    expect(queries[0]).toContain('(pointer: coarse)');
    expect(normalized(element)).toBe('Xoay ngang điện thoại');
    expect(element.querySelector('button')).toBeNull();
  });

  it('asks a phone on its side to stand upright', () => {
    fakeMedia('(orientation: landscape)');
    const element = create('portrait', false);

    expect(normalized(element)).toBe('Xoay dọc điện thoại');
  });

  it('says nothing to a screen already the right way round', () => {
    fakeMedia('(orientation: landscape)');
    const element = create('landscape', true);

    expect(element.querySelector('.rotate')).toBeNull();
  });

  it('turns the screen from a button where the browser can, by full-screening the target first', () => {
    fakeMedia('(orientation: portrait)');
    const target = document.createElement('div');
    const fullscreen = spyOn(target, 'requestFullscreen').and.returnValue(Promise.resolve());
    const element = create('landscape', true, target);

    element.querySelector('button')!.click();

    expect(fullscreen).toHaveBeenCalled();
  });
});
