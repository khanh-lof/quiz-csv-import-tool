import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NgModel } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { provideNzDateFnsAdapter } from 'ng-zorro-antd/core/time';
import { NzDatePickerComponent } from 'ng-zorro-antd/date-picker';
import { DeadlinePicker } from './deadline-picker';

describe('DeadlinePicker', () => {
  let fixture: ComponentFixture<DeadlinePicker>;
  let picker: DeadlinePicker;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DeadlinePicker],
      providers: [provideNzDateFnsAdapter()]
    }).compileComponents();
    fixture = TestBed.createComponent(DeadlinePicker);
    picker = fixture.componentInstance;
    fixture.detectChanges();
  });

  const root = () => fixture.nativeElement as HTMLElement;
  const datePicker = () => fixture.debugElement.query(By.directive(NzDatePickerComponent));
  const pick = (date: Date) => datePicker().triggerEventHandler('ngModelChange', date);

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
    expect(datePicker()).toBeNull();
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

  it('shows a date picker for Chọn giờ and writes what is picked there', async () => {
    await choose(3);
    expect(picker.value()).toBeNull();
    expect(datePicker()).not.toBeNull();

    const picked = new Date(Date.now() + 3 * 86_400_000);
    picked.setSeconds(0, 0);
    pick(picked);
    await settle();

    expect(picker.value()).toEqual(picked);
    expect(root().textContent).toContain('Đóng lúc');
    expect(root().textContent).not.toContain('đã qua');
  });

  it('warns about a time that is already past', async () => {
    await choose(3);

    pick(new Date(2020, 0, 1, 8, 0));
    await settle();

    expect(picker.value()).toEqual(new Date(2020, 0, 1, 8, 0));
    expect(root().textContent).toContain('Giờ này đã qua');
  });

  it('takes a time set from outside as the custom time, and a null as none', async () => {
    const outside = new Date(Date.now() + 86_400_000);
    outside.setSeconds(0, 0);
    picker.value.set(outside);
    await settle();

    expect(datePicker().injector.get(NgModel).model).toEqual(outside);

    picker.value.set(null);
    await settle();

    expect(datePicker()).toBeNull();
    expect(root().querySelector<HTMLInputElement>('input[type="radio"]:checked')).toBe(
      root().querySelectorAll<HTMLInputElement>('input[type="radio"]')[0]);
  });
});
