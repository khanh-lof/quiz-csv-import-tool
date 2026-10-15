import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AVATARS, avatarDef } from '../../../models/avatar';
import { AvatarRing, AvatarSize, PlayerAvatar } from './player-avatar';

describe('PlayerAvatar', () => {
  let fixture: ComponentFixture<PlayerAvatar>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({imports: [PlayerAvatar]}).compileComponents();
    fixture = TestBed.createComponent(PlayerAvatar);
  });

  function show(inputs: { avatar?: string; name?: string; size?: AvatarSize; ring?: AvatarRing | null }): void {
    for (const [key, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(key, value);
    }
    fixture.detectChanges();
  }

  const host = () => fixture.nativeElement as HTMLElement;
  const style = () => getComputedStyle(host());

  it('shows the emoji of the avatar on a disc of its colour', () => {
    show({avatar: 'fox', name: 'Lan'});

    expect(host().textContent?.trim()).toBe('🦊');
    expect(host().querySelector('.emoji')).not.toBeNull();
    const probe = document.createElement('div');
    probe.style.background = avatarDef('fox')!.color;
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    expect(style().backgroundColor).toBe(expected);
  });

  it('draws every avatar of the set', () => {
    for (const avatar of AVATARS) {
      show({avatar: avatar.id});
      expect(host().textContent?.trim()).toBe(avatar.emoji);
    }
  });

  it('is hidden from assistive technology, since the name is always shown beside it', () => {
    show({avatar: 'cat', name: 'Lan'});

    expect(host().getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to the first letter of the name, upper-cased, when there is no avatar', () => {
    show({avatar: '', name: 'lan'});

    expect(host().textContent?.trim()).toBe('L');
    expect(host().querySelector('.letter')).not.toBeNull();
    expect(host().querySelector('.emoji')).toBeNull();
  });

  it('falls back the same way for an avatar id it does not know', () => {
    show({avatar: 'dodo', name: '  nguyễn An'});

    expect(host().textContent?.trim()).toBe('N');
  });

  it('keeps an accented or astral first character whole', () => {
    show({avatar: '', name: 'ếch'});
    expect(host().textContent?.trim()).toBe('Ế');

    show({name: '😀 Lan'});
    expect(host().textContent?.trim()).toBe('😀');
  });

  it('shows a question mark for a student with no name and no avatar', () => {
    show({avatar: '', name: '   '});

    expect(host().textContent?.trim()).toBe('?');
  });

  it('is 28, 36, 56 and 88 px wide for its four sizes, 36 by default', () => {
    show({avatar: 'cat'});
    expect(style().width).toBe('36px');

    const widths: string[] = [];
    for (const size of ['sm', 'md', 'lg', 'xl'] as const) {
      show({size});
      widths.push(style().width);
    }
    expect(widths).toEqual(['28px', '36px', '56px', '88px']);
    expect(style().height).toBe('88px');
  });

  it('sizes the emoji at about 0.6 of the disc', () => {
    show({avatar: 'cat', size: 'xl'});

    expect(parseFloat(getComputedStyle(host().querySelector('.emoji')!).fontSize)).toBeCloseTo(88 * 0.6, 1);
  });

  it('takes its size from --avatar-size when a page sets one', () => {
    host().style.setProperty('--avatar-size', '44px');
    show({avatar: 'cat', size: 'xl'});

    expect(style().width).toBe('44px');
  });

  it('draws no ring by default, and a 3px border in the medal colour with one', () => {
    show({avatar: 'cat'});
    expect(style().borderTopWidth).toBe('0px');

    const colours: string[] = [];
    for (const ring of ['gold', 'silver', 'bronze'] as const) {
      show({ring});
      expect(style().borderTopWidth).toBe('3px');
      colours.push(style().borderTopColor);
    }
    expect(colours).toEqual(['rgb(245, 179, 1)', 'rgb(168, 178, 193)', 'rgb(205, 127, 74)']);
    // The ring is inside the size, so the avatar does not grow.
    expect(style().width).toBe('36px');
  });
});
