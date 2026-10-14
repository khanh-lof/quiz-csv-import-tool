import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ShareJoin } from './share-join';

describe('ShareJoin', () => {
  let fixture: ComponentFixture<ShareJoin>;
  let joined: string[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({imports: [ShareJoin]}).compileComponents();
    fixture = TestBed.createComponent(ShareJoin);
    fixture.componentRef.setInput('title', 'HSK1 bài 1');
    joined = [];
    fixture.componentInstance.join.subscribe(name => joined.push(name));
    fixture.detectChanges();
  });

  const root = () => fixture.nativeElement as HTMLElement;
  const input = () => root().querySelector('input')!;
  const button = () => root().querySelector('button')!;

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
    expect(root().textContent).toContain('Dùng tên thật để thầy cô nhận ra bạn nhé.');
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

  it('emits the trimmed name when the button is pressed', async () => {
    await type('  Lan  ');
    expect(button().disabled).toBeFalse();

    button().click();

    expect(joined).toEqual(['Lan']);
  });

  it('emits the name on Enter', async () => {
    await type('Lan');

    input().dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));

    expect(joined).toEqual(['Lan']);
  });

  it('does not take an Enter that ends an input-method composition', async () => {
    await type('Lan');

    input().dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', isComposing: true}));

    expect(joined).toEqual([]);
  });

  it('does nothing while busy, and shows it on the button', async () => {
    await type('Lan');
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();

    expect(button().disabled).toBeTrue();
    expect(button().classList).toContain('ant-btn-loading');
    input().dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
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
});
