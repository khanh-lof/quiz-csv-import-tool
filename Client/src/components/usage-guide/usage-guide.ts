import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { MessagePipe } from '../../i18n/messages';

// A "how to use this page" button that opens the guide in a popup, so the page itself keeps its full
// width and height. The projected content is the guide's text.
@Component({
  selector: 'kt-quiz-usage-guide',
  imports: [NzButtonComponent, NzIconDirective, NzModalModule, MessagePipe],
  templateUrl: './usage-guide.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './usage-guide.css'
})
export class UsageGuide {
  protected readonly isOpen = signal(false);
}
