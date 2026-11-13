import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  DestroyRef,
  inject,
  signal
} from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { catchError, filter, map, of } from 'rxjs';
import { NzBreadCrumbComponent, NzBreadCrumbItemComponent } from 'ng-zorro-antd/breadcrumb';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzMenuDirective, NzMenuItemComponent, NzSubMenuComponent } from 'ng-zorro-antd/menu';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AuthService } from '../../services/auth.service';
import { MessageKey, MessagePipe } from '../../i18n/messages';

// The pages of the frame, as the routes that host them: the two ways of building a quiz, the history of the
// AI ones, and the assignments of the gesture quizzes.
type WorkspaceMode = '/quiz' | '/ai' | '/ai-history' | '/assignments';

// One item of the side menu. `/play` is the only one outside the frame: the game is a full-screen page of its
// own, so it is never highlighted and never in the breadcrumb.
export interface NavPage {
  route: WorkspaceMode | '/play';
  label: MessageKey;
  icon: string;
  // The breadcrumb's last crumb on a page below this one (an assignment's leaderboard, a "Ghép bộ thủ" exercise).
  childLabel?: MessageKey;
}

// A top-level entry of the menu: a page of its own, or a group of pages shown as an inline submenu.
export type NavEntry = NavPage | { label: MessageKey; icon: string; pages: NavPage[] };

export interface Crumb {
  label: MessageKey;
  // Set when the crumb leads somewhere other than the page on screen.
  link?: string;
}

export const NAV: NavEntry[] = [
  {
    route: '/quiz',
    label: 'app.workspace.navManualQuiz',
    icon: 'table'
  },
  {
    label: 'app.workspace.navAi',
    icon: 'robot',
    pages: [
      {
        route: '/ai',
        label: 'app.workspace.navCreateQuiz',
        icon: 'thunderbolt'
      },
      {
        route: '/ai-history',
        label: 'app.workspace.navHistory',
        icon: 'history',
        childLabel: 'app.workspace.navRadicals'
      }
    ]
  },
  {
    label: 'app.workspace.navGame',
    icon: 'camera',
    pages: [
      {
        route: '/play',
        label: 'app.workspace.navPlayGame',
        icon: 'play-circle'
      },
      {
        route: '/assignments',
        label: 'app.workspace.navAssignments',
        icon: 'trophy',
        childLabel: 'common.leaderboardTitle'
      }
    ]
  }
];

// The breadcrumb of a URL inside the frame: the menu group (plain text, it is no page), the page, and for a page
// below it (an assignment's leaderboard, an exercise of the history) one more level.
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
    }, { label: page.childLabel ?? page.label }];
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
  selector: 'kt-quiz-workspace',
  imports: [
    NgOptimizedImage,
    RouterOutlet,
    RouterLink,
    NzBreadCrumbComponent,
    NzBreadCrumbItemComponent,
    NzIconDirective,
    NzMenuDirective,
    NzMenuItemComponent,
    NzSubMenuComponent,
    MessagePipe
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

  protected readonly narrow = matchMedia(NARROW_QUERY).matches;
  protected readonly collapsed = signal(this.narrow || this.storedCollapsed());

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
