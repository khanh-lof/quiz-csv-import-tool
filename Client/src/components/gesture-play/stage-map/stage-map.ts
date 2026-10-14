import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzPopconfirmDirective } from 'ng-zorro-antd/popconfirm';
import { NzRadioComponent, NzRadioGroupComponent } from 'ng-zorro-antd/radio';
import { NzSwitchComponent } from 'ng-zorro-antd/switch';
import { NzTagComponent } from 'ng-zorro-antd/tag';
import { STAGES, StageDef } from '../../../game/stages';
import { GestureQuiz, questionCount } from '../../../models/gesture-quiz';
import {
  GestureProgressService,
  POINTS_PER_CORRECT,
  StageBest,
} from '../../../services/gesture-progress.service';
import { GestureSettingsService, TimeMode } from '../gesture-settings.service';

// 'empty' is a stage this quiz has no questions for: nothing to play, and it does not hold up the next one.
type StageStatus = 'passed' | 'open' | 'locked' | 'empty';

interface StageCard {
  def: StageDef;
  count: number;
  best: StageBest | null;
  status: StageStatus;
}

// The six stages as cards with their questions, best result and lock, plus the play settings and the
// reset. The page opens a stage when a card is chosen; everything else here is read from the progress
// and settings services, so the map updates itself.
@Component({
  selector: 'app-gesture-stage-map',
  imports: [
    FormsModule,
    NzButtonComponent,
    NzIconDirective,
    NzPopconfirmDirective,
    NzRadioComponent,
    NzRadioGroupComponent,
    NzSwitchComponent,
    NzTagComponent,
  ],
  templateUrl: './stage-map.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './stage-map.css'
})
export class GestureStageMap {
  readonly quiz = input.required<GestureQuiz>();

  readonly start = output<number>();

  private readonly progress = inject(GestureProgressService);
  private readonly settingsService = inject(GestureSettingsService);

  protected readonly settings = this.settingsService.settings;
  protected readonly total = computed(() => questionCount(this.quiz()));

  protected readonly cards = computed<StageCard[]>(() => {
    const quiz = this.quiz();
    return STAGES.map(def => {
      const count = quiz.stages.get(def.stage)?.length ?? 0;
      const status: StageStatus =
        count === 0 ? 'empty'
          : this.progress.isPassed(quiz.key, def.stage) ? 'passed'
            : this.progress.isUnlocked(quiz, def.stage) ? 'open'
              : 'locked';
      return { def, count, best: this.progress.best(quiz.key, def.stage), status };
    });
  });

  // Every stage that has questions is passed: the quiz is finished.
  protected readonly allPassed = computed(() => {
    const playable = this.cards().filter(card => card.status !== 'empty');
    return playable.length > 0 && playable.every(card => card.status === 'passed');
  });

  protected readonly totalScore = computed(() =>
    this.cards().reduce((sum, card) => sum + (card.best?.correct ?? 0) * POINTS_PER_CORRECT, 0));

  protected readonly pointsPerCorrect = POINTS_PER_CORRECT;

  protected setTimeMode(mode: TimeMode): void {
    this.settingsService.update({ timeMode: mode });
  }

  protected setSound(sound: boolean): void {
    this.settingsService.update({ sound });
  }

  protected resetProgress(): void {
    this.progress.reset(this.quiz().key);
  }
}
