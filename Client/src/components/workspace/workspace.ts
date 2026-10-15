import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
  viewChildren
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { catchError, filter, map, of } from 'rxjs';
import { NzBreadCrumbComponent, NzBreadCrumbItemComponent } from 'ng-zorro-antd/breadcrumb';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzMenuDirective, NzMenuItemComponent, NzSubMenuComponent } from 'ng-zorro-antd/menu';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzTooltipDirective } from 'ng-zorro-antd/tooltip';
import { AuthService } from '../../services/auth.service';

// The pages of the frame, as the routes that host them: the two ways of building a quiz, the history of the
// AI ones, and the assignments of the gesture quizzes.
type WorkspaceMode = '/quiz' | '/ai' | '/ai-history' | '/assignments';

// One item of the side menu. `/play` is the only one outside the frame: the game is a full-screen page of its
// own, so it is never highlighted and never in the breadcrumb.
export interface NavPage {
  route: WorkspaceMode | '/play';
  label: string;
  icon: string;
  hint: string;
}

// A top-level entry of the menu: a page of its own, or a group of pages shown as an inline submenu.
export type NavEntry = NavPage | { label: string; icon: string; pages: NavPage[] };

export interface Crumb {
  label: string;
  // Set when the crumb leads somewhere other than the page on screen.
  link?: string;
}

export const NAV: NavEntry[] = [
  {
    route: '/quiz',
    label: 'Quiz thủ công',
    icon: 'table',
    hint: 'Tự nhập câu hỏi và đáp án vào bảng, rồi tải file quiz. Không cần đăng nhập.'
  },
  {
    label: 'AI',
    icon: 'robot',
    pages: [
      {
        route: '/ai',
        label: 'Tạo quiz',
        icon: 'thunderbolt',
        hint: 'Gửi ảnh bài học (hoặc chỉ chọn bài) để AI soạn câu hỏi giúp. Cần đăng nhập.'
      },
      {
        route: '/ai-history',
        label: 'Lịch sử',
        icon: 'history',
        hint: 'Các lần tạo bằng AI: xem trạng thái, tải file, chơi ngay hoặc giao bài. Cần đăng nhập.'
      }
    ]
  },
  {
    label: 'Game',
    icon: 'camera',
    pages: [
      {
        route: '/play',
        label: 'Chơi game',
        icon: 'play-circle',
        hint: 'Chơi quiz do AI tạo bằng cử chỉ trước camera, hoặc thử quiz mẫu.'
      },
      {
        route: '/assignments',
        label: 'Bài đã giao',
        icon: 'trophy',
        hint: 'Các game đã giao cho học sinh: link, mã QR và bảng xếp hạng. Cần đăng nhập.'
      }
    ]
  }
];

// The breadcrumb of a URL inside the frame: the menu group (plain text, it is no page), the page, and for an
// assignment's leaderboard one more level below its list.
export function breadcrumbFor(url: string): Crumb[] {
  const path = url.split(/[?#]/)[0];
  for (const entry of NAV) {
    const pages = 'pages' in entry ? entry.pages : [entry];
    const page = pages.find(p => path === p.route || path.startsWith(p.route + '/'));
    if (!page) continue;
    const trail: Crumb[] = 'pages' in entry ? [{ label: entry.label }] : [];
    if (path === page.route) {
      return [...trail, { label: page.label }];
    }
    return [...trail, {
      label: page.label,
      link: page.route
    }, { label: 'Bảng xếp hạng' }];
  }
  return [];
}

const COLLAPSED_STORAGE_KEY = 'workspace-nav-collapsed';
// Below this width the side menu starts collapsed, and opening it lays it over the page instead of beside it.
const NARROW_QUERY = '(max-width: 767px)';

// Frame shared by the vocabulary table, the AI pages and the assignment pages: a collapsible side menu (the
// pages, grouped as inline submenus, and the account action), the breadcrumb and the title. Switching is plain
// router navigation, so the auth guard sends an anonymous user to log in, and a refused navigation simply
// leaves the current item highlighted.
@Component({
  selector: 'app-workspace',
  imports: [
    RouterOutlet,
    RouterLink,
    NzBreadCrumbComponent,
    NzBreadCrumbItemComponent,
    NzIconDirective,
    NzMenuDirective,
    NzMenuItemComponent,
    NzSubMenuComponent,
    NzTooltipDirective
  ],
  templateUrl: './workspace.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './workspace.css'
})
export class Workspace {
  protected readonly nav = NAV;
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);
  private readonly notificationService = inject(NzNotificationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      map(() => this.router.url)
    ),
    { initialValue: this.router.url }
  );

  protected readonly mode = computed(() => this.modeOf(this.url()));
  protected readonly breadcrumb = computed(() => breadcrumbFor(this.url()));

  private readonly narrow = matchMedia(NARROW_QUERY).matches;
  protected readonly collapsed = signal(this.narrow || this.storedCollapsed());

  private readonly tooltips = viewChildren(NzTooltipDirective);

  constructor() {
    // Turning a trigger off leaves an open tooltip up, so the one on the item just navigated to (or on the
    // collapse switch just used) is closed here.
    effect(() => {
      this.mode();
      this.collapsed();
      untracked(() => this.tooltips().forEach(tooltip => tooltip.hide()));
    });
  }

  // The router puts a mode's page on screen before its first change detection, which runs a task later.
  // In between the browser can draw the page without its ng-zorro classes (button types, checked radios,
  // input styles), and their `transition: all` then plays every control into its style slowly. Rendering
  // the page right away gives it its full styles before it is ever drawn.
  protected onPageActivate(): void {
    this.cdr.detectChanges();
  }

  protected isGroup(entry: NavEntry): entry is Extract<NavEntry, { pages: NavPage[] }> {
    return 'pages' in entry;
  }

  // An item's tooltip: always its name while the menu shows only icons, else the explanation, except on the
  // page on screen, which already explains itself. It is turned off through the trigger, not by clearing the
  // title, so the open one fades out with its text.
  protected tooltipOf(page: NavPage): string {
    return this.collapsed() ? `${page.label}: ${page.hint}` : page.hint;
  }

  protected tooltipTrigger(page: NavPage): 'hover' | null {
    return page.route === this.mode() ? null : 'hover';
  }

  protected toggleCollapsed(): void {
    this.collapsed.update(collapsed => !collapsed);
    // A phone always starts collapsed, so only the wide layout's choice is remembered.
    if (!this.narrow) {
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, String(this.collapsed()));
      } catch {
        // Remembering the choice is only a convenience.
      }
    }
  }

  // On a phone the open menu covers the page, so picking a page closes it again.
  protected onMenuClick(): void {
    if (this.narrow && !this.collapsed()) {
      this.collapsed.set(true);
    }
  }

  protected isLoggedIn(): boolean {
    return this.authService.hasAccessToken();
  }

  protected login(): void {
    this.router.navigate(['/login'], { queryParams: { returnUrl: this.router.url } });
  }

  protected logout(): void {
    this.authService.logout().pipe(
      catchError(() => of(null)),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => {
      this.notificationService.success('Đã đăng xuất', 'Hẹn gặp lại nhaa.', { nzPlacement: 'top' });
      // The AI and assignment pages need a login, so fall back to the table that works anonymously.
      if (this.mode() !== '/quiz') {
        this.router.navigateByUrl('/quiz');
      }
    });
  }

  private storedCollapsed(): boolean {
    try {
      return localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private modeOf(url: string): WorkspaceMode {
    if (url.startsWith('/ai-history')) {
      return '/ai-history';
    }
    return url.startsWith('/ai') ? '/ai' : url.startsWith('/assignments') ? '/assignments' : '/quiz';
  }
}
