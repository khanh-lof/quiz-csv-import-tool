import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { OnlineStatusService } from '../services/online-status.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class App {
  private readonly onlineStatusService = inject(OnlineStatusService);

  constructor() {
    // An image dropped outside a drop zone would otherwise be opened by the browser, leaving the app.
    document.addEventListener('dragover', (e) => e.preventDefault(), false);
    document.addEventListener('drop', (e) => e.preventDefault(), false);
  }
}
