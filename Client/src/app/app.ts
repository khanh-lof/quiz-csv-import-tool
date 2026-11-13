import { afterNextRender, ChangeDetectionStrategy, Component, inject, TemplateRef, viewChild } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { AiJobService, HistoryLinkContext } from '../services/ai-job.service';
import { OnlineStatusService } from '../services/online-status.service';
import { MessagePipe } from '../i18n/messages';

@Component({
  selector: 'kt-quiz-root',
  imports: [RouterOutlet, RouterLink, MessagePipe],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class App {
  private readonly onlineStatusService = inject(OnlineStatusService);
  private readonly jobService = inject(AiJobService);
  private readonly historyLinkContent = viewChild.required<TemplateRef<HistoryLinkContext>>('historyLinkContent');

  constructor() {
    afterNextRender(() => this.jobService.historyLinkContent.set(this.historyLinkContent()));
    // An image dropped outside a drop zone would otherwise be opened by the browser, leaving the app.
    document.addEventListener('dragover', (e) => e.preventDefault(), false);
    document.addEventListener('drop', (e) => e.preventDefault(), false);
  }
}
