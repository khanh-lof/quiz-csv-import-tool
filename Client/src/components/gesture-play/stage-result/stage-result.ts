import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { stageDef } from '../../../game/stages';

// A question the player got wrong or ran out of time on, with what they should have answered.
export interface MissedQuestion {
  question: string;
  answer: string;
  explanation: string;
  timedOut: boolean;
}

// How one run of a stage ended; the page builds it when the last question is judged.
export interface StageRunResult {
  stage: number;
  correct: number;
  total: number;
  points: number;
  passMark: number;
  passed: boolean;
  bestStreak: number;
  missed: MissedQuestion[];
  // Whether a later stage with questions can be opened now (only after a pass).
  hasNext: boolean;
}

// The screen after a stage: the verdict against the pass mark, the questions to learn from, and where
// to go next.
@Component({
  selector: 'app-gesture-stage-result',
  imports: [NzButtonComponent, NzIconDirective],
  templateUrl: './stage-result.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './stage-result.css'
})
export class GestureStageResult {
  readonly result = input.required<StageRunResult>();

  readonly nextStage = output<void>();
  readonly retry = output<void>();
  readonly toMap = output<void>();

  protected readonly def = computed(() => stageDef(this.result().stage));
}
