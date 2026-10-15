import { TestBed } from '@angular/core/testing';
import { MarqueeSettings } from './marquee-settings.service';

const KEY = 'leaderboard-marquee-paused';

describe('MarqueeSettings', () => {
  beforeEach(() => localStorage.removeItem(KEY));
  afterEach(() => localStorage.removeItem(KEY));

  const create = () => TestBed.inject(MarqueeSettings);
  // A second instance, as a later visit to the page would make.
  const another = () => TestBed.runInInjectionContext(() => new MarqueeSettings());

  it('is not paused by default', () => {
    expect(create().paused()).toBeFalse();
  });

  it('starts paused when the browser remembers it', () => {
    localStorage.setItem(KEY, '1');

    expect(create().paused()).toBeTrue();
  });

  it('starts running for a stored 0 and for a value it does not know', () => {
    localStorage.setItem(KEY, '0');
    expect(another().paused()).toBeFalse();

    localStorage.setItem(KEY, 'yes');
    expect(another().paused()).toBeFalse();
  });

  it('toggles, and keeps the choice as 1 or 0', () => {
    const settings = create();

    settings.toggle();
    expect(settings.paused()).toBeTrue();
    expect(localStorage.getItem(KEY)).toBe('1');

    settings.toggle();
    expect(settings.paused()).toBeFalse();
    expect(localStorage.getItem(KEY)).toBe('0');
  });

  it('sets the choice directly', () => {
    const settings = create();

    settings.setPaused(true);
    settings.setPaused(true);
    expect(settings.paused()).toBeTrue();
    expect(localStorage.getItem(KEY)).toBe('1');

    settings.setPaused(false);
    expect(settings.paused()).toBeFalse();
    expect(localStorage.getItem(KEY)).toBe('0');
  });

  it('is one choice for every user of the service, and a later visit finds it', () => {
    create().setPaused(true);

    expect(TestBed.inject(MarqueeSettings).paused()).toBeTrue();
    expect(another().paused()).toBeTrue();
  });

  it('keeps the choice in memory, and reads not paused, when the storage is blocked', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('blocked');
    spyOn(Storage.prototype, 'setItem').and.throwError('blocked');
    const settings = create();
    expect(settings.paused()).toBeFalse();

    settings.toggle();
    expect(settings.paused()).toBeTrue();
    settings.toggle();
    expect(settings.paused()).toBeFalse();
  });
});
