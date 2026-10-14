import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { stageDef } from '../../../game/stages';
import { SubmitOutcome } from '../../../models/assignment';

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
}

// What a student's result screen says about sending the run to the teacher.
export type SaveState = 'saving' | SubmitOutcome;

const SAVE_TEXT: Record<SaveState, string> = {
  saving: 'Đang lưu kết quả…',
  saved: 'Đã lưu kết quả cho thầy cô ✓',
  queued: 'Chưa gửi được kết quả, máy sẽ tự gửi lại khi có mạng.',
  closed: 'Bài đã đóng nên kết quả này không được lưu.',
  rejected: 'Máy chủ không nhận kết quả này. Nếu thầy cô đã xóa tên bạn khỏi bài, hãy vào lại bằng tên khác.',
};

// The screen after a stage: the verdict against the pass mark, the questions to learn from, and where
// to go next. For a student's assignment it also says what became of the run (`saveState`), and in the
// teacher's preview (`preview`) that nothing is kept.
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
  readonly preview = input(false);

  readonly nextStage = output<void>();
  readonly retry = output<void>();
  readonly toMap = output<void>();

  protected readonly def = computed(() => stageDef(this.result().stage));
  protected readonly saveText = computed(() => {
    if (this.preview()) {
      return 'Xem thử: kết quả không được lưu.';
    }
    const state = this.saveState();
    return state ? SAVE_TEXT[state] : '';
  });
}
