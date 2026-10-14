import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { Assignment } from '../../../models/assignment';
import { AssignmentList } from './assignment-list';

const URL = '/api/assignments';

function assignment(id: string, overrides: Partial<Assignment> = {}): Assignment {
  return {
    id, code: 'K7M2X9QD4P', jobId: 'job-1', title: `Quiz ${id}`, label: '', timeMode: 'standard', stageLock: 'sequential',
    stageCounts: {'1': 5}, createdAt: '2026-10-14T01:30:00Z', closesAt: null, closedAt: null, open: true,
    playerCount: 0, ...overrides,
  };
}

describe('AssignmentList', () => {
  let fixture: ComponentFixture<AssignmentList>;
  let http: HttpTestingController;
  let notifications: jasmine.SpyObj<NzNotificationService>;

  beforeEach(() => {
    notifications = jasmine.createSpyObj('NzNotificationService', ['success', 'warning', 'error']);
    TestBed.configureTestingModule({
      imports: [AssignmentList],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {provide: NzNotificationService, useValue: notifications},
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // The icons are fetched as files from assets/ when first drawn, which is not what these specs are about.
    http.match(request => request.url.startsWith('assets/'));
    http.verify();
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const text = (): string => root().textContent ?? '';
  // The table also has a measuring row and, when empty, a placeholder row: only the assignments' own rows count.
  const rows = (): HTMLElement[] =>
    Array.from(root().querySelectorAll<HTMLElement>('td.assignment-title')).map(cell => cell.closest('tr')!);
  // The actions live in a dropdown that renders in an overlay outside the row: open the row's, then look there.
  async function menuItem(row: HTMLElement, label: string): Promise<HTMLElement> {
    row.querySelector<HTMLButtonElement>('button[aria-label="Thao tác"]')!.click();
    // The overlay opens after a short debounce of its own.
    await new Promise(resolve => setTimeout(resolve, 250));
    await settle();
    const found = Array.from(document.body.querySelectorAll<HTMLElement>('.ant-dropdown li[nz-menu-item]'))
      .find(candidate => candidate.textContent?.trim() === label);
    if (!found) {
      throw new Error(`No menu item "${label}"`);
    }
    return found;
  }

  // A short real wait rather than whenStable(): an open modal's animation keeps the zone busy.
  async function settle(): Promise<void> {
    fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve, 20));
    fixture.detectChanges();
  }

  async function load(...list: Assignment[]): Promise<void> {
    fixture = TestBed.createComponent(AssignmentList);
    fixture.detectChanges();
    http.expectOne(URL).flush({assignments: list});
    await settle();
  }

  it('lists the assignments with their label, status, student count and ways to act', async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    await load(
      assignment('a', {label: 'Lớp 3A', playerCount: 12, closesAt: soon}),
      assignment('b', {closedAt: '2026-10-14T02:00:00Z', open: false, playerCount: 3}));

    const [first, second] = rows();
    expect(rows().length).toBe(2);
    expect(first.textContent).toContain('Quiz a');
    expect(first.querySelector('nz-tag')?.textContent).toContain('Lớp 3A');
    expect(first.textContent).toContain('Đang mở · đóng lúc');
    expect(first.textContent).toContain('12');
    expect(await menuItem(first, 'Đóng bài')).toBeTruthy();
    expect(await menuItem(second, 'Mở lại')).toBeTruthy();
    expect(second.textContent).toContain('Đã đóng');
  });

  it('points an empty list at the AI tab', async () => {
    await load();

    expect(rows().length).toBe(0);
    expect(text()).toContain('chọn một Game đã xong và bấm Giao bài');
    expect(root().querySelector('a[href="/ai-history"]')?.textContent).toContain('Đến AI › Lịch sử');
  });

  it('tells the teacher when the list could not be loaded', async () => {
    fixture = TestBed.createComponent(AssignmentList);
    fixture.detectChanges();
    http.expectOne(URL).flush('boom', {status: 500, statusText: 'Server Error'});
    await settle();

    expect(notifications.error).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Chưa tải được danh sách');
  });

  it('reopens a closed assignment with no closing time, keeping the student count', async () => {
    await load(assignment('b', {closedAt: '2026-10-14T02:00:00Z', open: false, playerCount: 3}));

    (await menuItem(rows()[0], 'Mở lại')).click();
    await settle();
    const ok = document.body.querySelector<HTMLButtonElement>('.ant-modal-footer .ant-btn-primary')!;
    expect(ok.textContent?.trim()).toBe('Mở lại');
    ok.click();
    await settle();

    const request = http.expectOne(`${URL}/b`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({closed: false, closesAt: null});
    request.flush(assignment('b', {playerCount: 0}));
    await settle();

    expect(rows()[0].textContent).toContain('Đang mở');
    expect(rows()[0].textContent).not.toContain('Đã đóng');
    expect(rows()[0].querySelectorAll('td')[2].textContent?.trim()).toBe('3');
  });

  it('keeps the reopen dialog open and says why when the server refuses', async () => {
    await load(assignment('b', {closedAt: '2026-10-14T02:00:00Z', open: false}));

    (await menuItem(rows()[0], 'Mở lại')).click();
    await settle();
    document.body.querySelector<HTMLButtonElement>('.ant-modal-footer .ant-btn-primary')!.click();
    await settle();
    http.expectOne(`${URL}/b`).flush('Assignment not found', {status: 404, statusText: 'Not Found'});
    await settle();

    expect(notifications.error).toHaveBeenCalledTimes(1);
    expect(notifications.error.calls.mostRecent().args[1]).toContain('Không tìm thấy bài này');
    expect(document.body.querySelector('.ant-modal-footer')).not.toBeNull();
  });
});
