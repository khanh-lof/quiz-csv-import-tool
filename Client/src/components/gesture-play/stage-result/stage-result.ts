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
  // The stage's identity (which game it was), and the number the screen says for it: its position among
  // the stages the quiz has.
  stage: number;
  position: number;
  correct: number;
  total: number;
  points: number;
  passMark: number;
  passed: boolean;
  bestStreak: number;
  missed: MissedQuestion[];
  // Whether a later stage with questions can be opened now: after a pass, or at once in the teacher's preview.
  hasNext: boolean;
  // Whether this run passed and every stage of the quiz is passed with it; never in the teacher's preview.
  allPassed: boolean;
}

// What a student's result screen says about the run's record. The server records a run itself as it judges the
// last answer, so the result is only shown once it is kept: there is nothing in between to wait for.
export type SaveState = 'saved';

const SAVE_TEXT: Record<SaveState, string> = {
  saved: 'Đã lưu kết quả cho thầy cô ✓',
};

// The screen after a stage: the verdict against the pass mark, the questions to learn from, and where
// to go next. For a student's assignment it also says the run was kept (`saveState`). A stage with no runs
// left (`attemptsLeft` 0) cannot be replayed.
@Component({
  selector: 'app-gesture-stage-result',
  imports: [NzButtonComponent, NzIconDirective],
  templateUrl: './stage-result.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './stage-result.css'
})
export class GestureStageResult {
  readonly result = input.required<StageRunResult>();
  readonly saveState = input<SaveState | null>(null);
  // The runs left on this stage when the teacher limited them (null: no limit). At 0 there is no replay.
  readonly attemptsLeft = input<number | null>(null);

  readonly nextStage = output<void>();
  readonly retry = output<void>();
  readonly toMap = output<void>();

  protected readonly def = computed(() => stageDef(this.result().stage));
  protected readonly saveText = computed(() => {
    const state = this.saveState();
    return state ? SAVE_TEXT[state] : '';
  });
}
