import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AVATARS } from '../../../models/avatar';
import { AvatarPicker } from './avatar-picker';

describe('AvatarPicker', () => {
  let fixture: ComponentFixture<AvatarPicker>;
  let picker: AvatarPicker;

  beforeEach(async () => {
    await TestBed.configureTestingModule({imports: [AvatarPicker]}).compileComponents();
    fixture = TestBed.createComponent(AvatarPicker);
    picker = fixture.componentInstance;
    fixture.detectChanges();
  });

  const root = () => fixture.nativeElement as HTMLElement;
  const group = () => root().querySelector<HTMLElement>('[role="radiogroup"]')!;
  const radios = () => Array.from(root().querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
  const checked = () => radios().filter(radio => radio.getAttribute('aria-checked') === 'true');
  const randomButton = () => root().querySelector<HTMLButtonElement>('.actions button')!;

  function press(index: number, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true});
    radios()[index].dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }

  describe('the grid', () => {
    it('is a radio group named "Hình đại diện" with one radio for each of the 24 avatars, in order', () => {
      expect(group().getAttribute('aria-label')).toBe('Hình đại diện');
      expect(radios().length).toBe(24);
      expect(radios().map(radio => radio.getAttribute('aria-label'))).toEqual(AVATARS.map(avatar => avatar.name));
    });

    it('names each radio in Vietnamese in its label and its tooltip, and draws its emoji', () => {
      radios().forEach((radio, i) => {
        expect(radio.type).toBe('button');
        expect(radio.getAttribute('title')).toBe(AVATARS[i].name);
        expect(radio.querySelector('app-player-avatar')?.textContent?.trim()).toBe(AVATARS[i].emoji);
      });
    });

    it('has six columns', () => {
      const tops = new Set(radios().slice(0, 6).map(radio => Math.round(radio.getBoundingClientRect().top)));
      const seventh = Math.round(radios()[6].getBoundingClientRect().top);

      expect(tops.size).toBe(1);
      expect(seventh).toBeGreaterThan([...tops][0]);
    });

    it('fits six avatars in a 320px phone', () => {
      root().style.display = 'block';
      root().style.width = '288px';
      const rects = radios().slice(0, 6).map(radio => radio.getBoundingClientRect());

      expect(rects[5].right).toBeLessThanOrEqual(root().getBoundingClientRect().right + 0.5);
      expect(rects[0].width).toBeGreaterThanOrEqual(30);
    });
  });

  describe('choosing', () => {
    it('starts with nothing checked, and the first radio the one in the tab order', () => {
      expect(picker.value()).toBe('');
      expect(checked().length).toBe(0);
      expect(radios().map(radio => radio.tabIndex)).toEqual([0, ...Array(23).fill(-1)]);
      expect(root().querySelector('.check')).toBeNull();
    });

    it('checks the radio that is clicked, and sets the value', () => {
      radios()[4].click();
      fixture.detectChanges();

      expect(picker.value()).toBe('cat');
      expect(checked()).toEqual([radios()[4]]);
    });

    it('moves the check to another radio when it is clicked', () => {
      radios()[4].click();
      radios()[13].click();
      fixture.detectChanges();

      expect(picker.value()).toBe('panda');
      expect(checked()).toEqual([radios()[13]]);
    });

    it('shows a ring and a tick on the checked radio only', () => {
      radios()[2].click();
      fixture.detectChanges();

      expect(radios()[2].classList).toContain('is-selected');
      expect(radios()[2].querySelector('.check')?.textContent?.trim()).toBe('✓');
      expect(root().querySelectorAll('.check').length).toBe(1);
      expect(root().querySelectorAll('.is-selected').length).toBe(1);
    });

    it('puts only the checked radio in the tab order', () => {
      radios()[7].click();
      fixture.detectChanges();

      expect(radios().map(radio => radio.tabIndex)).toEqual(AVATARS.map((_, i) => i === 7 ? 0 : -1));
    });

    it('shows a value set from outside, and keeps the first radio tabbable for an unknown one', () => {
      fixture.componentRef.setInput('value', 'owl');
      fixture.detectChanges();
      expect(checked()).toEqual([radios()[20]]);
      expect(radios()[20].tabIndex).toBe(0);

      fixture.componentRef.setInput('value', 'dodo');
      fixture.detectChanges();
      expect(checked().length).toBe(0);
      expect(radios()[0].tabIndex).toBe(0);
    });
  });

  describe('the keyboard', () => {
    beforeEach(() => {
      radios()[4].click();
      fixture.detectChanges();
    });

    it('moves by one with the left and right arrows, selecting and focusing', () => {
      press(4, 'ArrowRight');
      expect(picker.value()).toBe('dragon');
      expect(document.activeElement).toBe(radios()[5]);

      press(5, 'ArrowLeft');
      press(4, 'ArrowLeft');
      expect(picker.value()).toBe('rabbit');
      expect(document.activeElement).toBe(radios()[3]);
    });

    it('moves by a row with the up and down arrows', () => {
      press(4, 'ArrowDown');
      expect(picker.value()).toBe(AVATARS[10].id);
      expect(document.activeElement).toBe(radios()[10]);

      press(10, 'ArrowUp');
      expect(picker.value()).toBe('cat');
      expect(document.activeElement).toBe(radios()[4]);
    });

    it('goes round the ends with left and right, and stops at the first and last rows with up and down', () => {
      press(4, 'Home');
      press(0, 'ArrowLeft');
      expect(picker.value()).toBe('turtle');
      press(23, 'ArrowRight');
      expect(picker.value()).toBe('rat');

      press(0, 'ArrowUp');
      expect(picker.value()).toBe('rat');
      press(0, 'End');
      press(23, 'ArrowDown');
      expect(picker.value()).toBe('turtle');
      press(23, 'ArrowDown');
      expect(picker.value()).toBe('turtle');
      // A step up from the last avatar lands one row above it.
      press(23, 'ArrowUp');
      expect(picker.value()).toBe(AVATARS[17].id);
    });

    it('jumps to the first and the last with Home and End', () => {
      press(4, 'End');
      expect(picker.value()).toBe('turtle');
      expect(document.activeElement).toBe(radios()[23]);

      press(23, 'Home');
      expect(picker.value()).toBe('rat');
      expect(document.activeElement).toBe(radios()[0]);
    });

    it('keeps the roving tab stop on the focused avatar', () => {
      press(4, 'ArrowRight');

      expect(radios().map(radio => radio.tabIndex)).toEqual(AVATARS.map((_, i) => i === 5 ? 0 : -1));
    });

    it('stops the page from scrolling on a key it uses, and ignores the others', () => {
      expect(press(4, 'ArrowDown').defaultPrevented).toBeTrue();
      expect(press(10, 'Home').defaultPrevented).toBeTrue();

      const before = picker.value();
      expect(press(0, 'a').defaultPrevented).toBeFalse();
      expect(press(0, 'Tab').defaultPrevented).toBeFalse();
      expect(picker.value()).toBe(before);
    });
  });

  describe('the random button', () => {
    it('is labelled with a dice and "Ngẫu nhiên"', () => {
      expect(randomButton().textContent?.trim()).toBe('🎲 Ngẫu nhiên');
      expect(randomButton().type).toBe('button');
    });

    it('picks an avatar when none is picked, from the random number', () => {
      spyOn(Math, 'random').and.returnValue(0.5);

      randomButton().click();
      fixture.detectChanges();

      expect(picker.value()).toBe(AVATARS[12].id);
      expect(checked().length).toBe(1);
    });

    it('always changes the picked avatar', () => {
      spyOn(Math, 'random').and.returnValue(0);
      radios()[0].click();
      fixture.detectChanges();
      expect(picker.value()).toBe('rat');

      randomButton().click();
      fixture.detectChanges();

      expect(picker.value()).not.toBe('rat');
      expect(picker.value()).toBe('ox');
    });
  });
});

@Component({
  imports: [AvatarPicker],
  template: `<app-avatar-picker [(value)]="avatar"/>`,
})
class Host {
  readonly avatar = signal('fox');
}

describe('AvatarPicker with two-way binding', () => {
  it('shows the bound value and writes a choice back', async () => {
    await TestBed.configureTestingModule({imports: [Host]}).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const radios = () => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button[role="radio"]'));

    expect(radios()[14].getAttribute('aria-checked')).toBe('true');

    radios()[1].click();
    fixture.detectChanges();

    expect(fixture.componentInstance.avatar()).toBe('ox');
    expect(radios()[1].getAttribute('aria-checked')).toBe('true');
  });
});
