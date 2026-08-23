import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { OnlineStatusService } from '../services/online-status.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  private readonly onlineStatusService = inject(OnlineStatusService);
}
