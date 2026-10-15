import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AVATARS } from '../../../models/avatar';
import { JoinRequest, ShareJoin } from './share-join';

describe('ShareJoin', () => {
  let fixture: ComponentFixture<ShareJoin>;
  let joined: JoinRequest[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ShareJoin] }).compileComponents();
    fixture = TestBed.createComponent(ShareJoin);
    fixture.componentRef.setInput('title', 'HSK1 bài 1');
    joined = [];
    fixture.componentInstance.join.subscribe(request => joined.push(request));
    fixture.detectChanges();
  });

  const root = () => fixture.nativeElement as HTMLElement;
  const input = () => root().querySelector('input')!;
  const button = () => root().querySelector<HTMLButtonElement>('.join-button')!;
  const radios = () => Array.from(root().querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
  const picked = () => radios().filter(radio => radio.getAttribute('aria-checked') === 'true');
  // The picture on top of the card: the emoji of the avatar it shows.
  const hero = () => root().querySelector<HTMLElement>('.hero app-player-avatar')!;
  const idOf = (radio: HTMLButtonElement) => AVATARS.find(avatar => avatar.name === radio.getAttribute('aria-label'))!.id;

  async function type(text: string): Promise<void> {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('shows the title, the label and the closing time', () => {
    fixture.componentRef.setInput('label', 'Lớp 6A');
    fixture.componentRef.setInput('closesAt', new Date(2026, 9, 14, 21, 30).toISOString());
    fixture.detectChanges();

    expect(root().textContent).toContain('HSK1 bài 1');
    expect(root().textContent).toContain('Lớp 6A');
    expect(root().textContent).toContain('Bài đóng lúc 21:30 14/10');
  });

  it('leaves the label and the closing time out when there are none', () => {
    expect(root().querySelector('.label')).toBeNull();
    expect(root().textContent).not.toContain('Bài đóng lúc');
  });

  it('limits the name to 40 characters', () => {
    expect(input().maxLength).toBe(40);
  });

  it('cannot join without a name, or with only spaces', async () => {
    expect(button().disabled).toBeTrue();
    await type('   ');
    expect(button().disabled).toBeTrue();

    button().click();
    expect(joined).toEqual([]);
  });

  it('emits the trimmed name and the picked avatar when the button is pressed', async () => {
    await type('  Lan  ');
    expect(button().disabled).toBeFalse();

    button().click();

    expect(joined).toEqual([{
      name: 'Lan',
      avatar: idOf(picked()[0])
    }]);
  });

  it('emits the name on Enter', async () => {
    await type('Lan');

    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(joined).toEqual([{
      name: 'Lan',
      avatar: idOf(picked()[0])
    }]);
  });

  it('does not take an Enter that ends an input-method composition', async () => {
    await type('Lan');

    input().dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true
    }));

    expect(joined).toEqual([]);
  });

  it('does nothing while busy, and shows it on the button', async () => {
    await type('Lan');
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();

    expect(button().disabled).toBeTrue();
    expect(button().classList).toContain('ant-btn-loading');
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(joined).toEqual([]);
  });

  it('shows the error under the field as an alert', () => {
    expect(root().querySelector('[role="alert"]')).toBeNull();

    fixture.componentRef.setInput('error', 'Tên này đã có bạn dùng, hãy thêm họ hoặc số');
    fixture.detectChanges();

    const alert = root().querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Tên này đã có bạn dùng');
    expect(input().getAttribute('aria-describedby')).toBe(alert.id);
  });

  describe('the avatar', () => {
    it('offers the picker under the name field, labelled, with the 24 avatars', () => {
      expect(root().textContent).toContain('Chọn hình đại diện');
      expect(root().querySelector('app-avatar-picker')).not.toBeNull();
      expect(radios().length).toBe(AVATARS.length);
    });

    it('starts with one avatar already picked, and the big picture shows it', () => {
      expect(picked().length).toBe(1);
      const chosen = AVATARS.find(avatar => avatar.id === idOf(picked()[0]))!;

      expect(hero().textContent?.trim()).toBe(chosen.emoji);
      expect(root().querySelector('.big-emoji')).toBeNull();
    });

    it('starts at a random avatar', () => {
      spyOn(Math, 'random').and.returnValue(0);
      const another = TestBed.createComponent(ShareJoin);
      another.componentRef.setInput('title', 'HSK1 bài 1');
      another.detectChanges();

      const first = another.nativeElement.querySelector('button[role="radio"][aria-checked="true"]') as HTMLElement;
      expect(first.getAttribute('aria-label')).toBe(AVATARS[0].name);
    });

    it('moves the big picture to the avatar that is clicked', () => {
      const other = radios().find(radio => radio.getAttribute('aria-checked') !== 'true')!;

      other.click();
      fixture.detectChanges();

      expect(picked()).toEqual([other]);
      expect(hero().textContent?.trim()).toBe(AVATARS.find(avatar => avatar.id === idOf(other))!.emoji);
    });

    it('joins with the avatar that was clicked, not the one it started with', async () => {
      const other = radios().find(radio => radio.getAttribute('aria-checked') !== 'true')!;
      other.click();
      fixture.detectChanges();
      await type('Lan');

      button().click();

      expect(joined).toEqual([{
        name: 'Lan',
        avatar: idOf(other)
      }]);
    });
  });
});
