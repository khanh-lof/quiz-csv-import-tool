import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DeadlinePicker } from './deadline-picker';
import { toLocalInputValue } from './deadline-picker-logic';

describe('DeadlinePicker', () => {
  let fixture: ComponentFixture<DeadlinePicker>;
  let picker: DeadlinePicker;

  beforeEach(async () => {
    await TestBed.configureTestingModule({imports: [DeadlinePicker]}).compileComponents();
    fixture = TestBed.createComponent(DeadlinePicker);
    picker = fixture.componentInstance;
    fixture.detectChanges();
  });

  const root = () => fixture.nativeElement as HTMLElement;
  const customInput = () => root().querySelector<HTMLInputElement>('input[type="datetime-local"]');

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function choose(index: number): Promise<void> {
    root().querySelectorAll<HTMLInputElement>('input[type="radio"]')[index].click();
    await settle();
  }

  it('offers the four presets and starts with no closing time', () => {
    const labels = Array.from(root().querySelectorAll('label')).map(label => label.textContent?.trim());

    expect(labels).toEqual(['Không hẹn giờ', 'Sau 45 phút', 'Hết hôm nay', 'Chọn giờ…']);
    expect(picker.value()).toBeNull();
    expect(customInput()).toBeNull();
  });

  it('writes the time of the preset that is chosen, and shows it', async () => {
    const before = Date.now();
    await choose(1);

    const value = picker.value()!;
    expect(value.getTime() - before).toBeGreaterThanOrEqual(45 * 60_000 - 1000);
    expect(value.getTime() - before).toBeLessThan(45 * 60_000 + 5000);
    expect(root().textContent).toMatch(/Đóng lúc \d{2}:\d{2} \d{2}\/\d{2}/);
  });

  it('closes at the end of the day for Hết hôm nay', async () => {
    await choose(2);

    const value = picker.value()!;
    expect(value.getHours()).toBe(23);
    expect(value.getMinutes()).toBe(59);
  });

  it('clears the time again for Không hẹn giờ', async () => {
    await choose(1);
    expect(picker.value()).not.toBeNull();

    await choose(0);

    expect(picker.value()).toBeNull();
    expect(root().textContent).not.toContain('Đóng lúc');
  });

  it('shows a time input for Chọn giờ and writes what is typed there', async () => {
    await choose(3);
    expect(picker.value()).toBeNull();
    expect(customInput()).not.toBeNull();

    const picked = new Date(Date.now() + 3 * 86_400_000);
    picked.setSeconds(0, 0);
    customInput()!.value = toLocalInputValue(picked);
    customInput()!.dispatchEvent(new Event('input'));
    await settle();

    expect(picker.value()).toEqual(picked);
    expect(root().textContent).toContain('Đóng lúc');
    expect(root().textContent).not.toContain('đã qua');
  });

  it('warns about a time that is already past', async () => {
    await choose(3);

    customInput()!.value = '2020-01-01T08:00';
    customInput()!.dispatchEvent(new Event('input'));
    await settle();

    expect(picker.value()).toEqual(new Date(2020, 0, 1, 8, 0));
    expect(root().textContent).toContain('Giờ này đã qua');
  });

  it('takes a time set from outside as the custom time, and a null as none', async () => {
    const outside = new Date(Date.now() + 86_400_000);
    outside.setSeconds(0, 0);
    picker.value.set(outside);
    await settle();

    expect(customInput()?.value).toBe(toLocalInputValue(outside));

    picker.value.set(null);
    await settle();

    expect(customInput()).toBeNull();
    expect(root().querySelector<HTMLInputElement>('input[type="radio"]:checked')).toBe(
      root().querySelectorAll<HTMLInputElement>('input[type="radio"]')[0]);
  });
});
