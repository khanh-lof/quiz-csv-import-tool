import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzPopconfirmDirective } from 'ng-zorro-antd/popconfirm';
import { NzRadioComponent, NzRadioGroupComponent } from 'ng-zorro-antd/radio';
import { NzSwitchComponent } from 'ng-zorro-antd/switch';
import { NzTagComponent } from 'ng-zorro-antd/tag';
import { STAGES, StageDef, stagePosition } from '../../../game/stages';
import { TIME_MODE_LABELS } from '../../../models/assignment';
import { GestureQuiz, questionCount } from '../../../models/gesture-quiz';
import {
  GestureProgressService,
  POINTS_PER_CORRECT,
  StageBest,
} from '../../../services/gesture-progress.service';
import { GestureSettingsService, TimeMode } from '../gesture-settings.service';

type StageStatus = 'passed' | 'open' | 'locked';

interface StageCard {
  def: StageDef;
  // The number the card shows ("Màn 2"): the stage's position among the stages the quiz has. `def.stage`
  // is still the stage's identity, which is what `start` emits.
  position: number;
  count: number;
  best: StageBest | null;
  status: StageStatus;
}

// A card for each stage the quiz has (a quiz holds 1 to 6 of the six), numbered by position and with its
// questions, best result and lock, plus the play settings and the reset. The page opens a stage when a
// card is chosen; everything else here is read from the progress and settings services, so the map
// updates itself. A quiz given as an assignment narrows the settings (`lockedTimeMode`, `allowReset`) and
// a teacher's preview opens every stage (`allOpen`); the page sets those, the map only shows them.
// Whatever the page puts inside the tag is shown above the summary.
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
  // The teacher's time mode, when there is one: shown as text, since the student cannot change it.
  readonly lockedTimeMode = input<TimeMode | null>(null);
  // Whether the player may wipe the quiz's progress: not for a student, whose results are the teacher's.
  readonly allowReset = input(true);
  // Every stage with questions can be opened, passed or not (the teacher's preview).
  readonly allOpen = input(false);

  readonly start = output<number>();

  private readonly progress = inject(GestureProgressService);
  private readonly settingsService = inject(GestureSettingsService);

  protected readonly settings = this.settingsService.settings;
  protected readonly total = computed(() => questionCount(this.quiz()));

  protected readonly cards = computed<StageCard[]>(() => {
    const quiz = this.quiz();
    return STAGES.filter(def => quiz.stages.has(def.stage)).map(def => {
      const status: StageStatus =
        this.progress.isPassed(quiz.key, def.stage) ? 'passed'
          : this.allOpen() || this.progress.isUnlocked(quiz, def.stage) ? 'open'
            : 'locked';
      return {
        def,
        position: stagePosition(quiz.stages.keys(), def.stage),
        count: quiz.stages.get(def.stage)?.length ?? 0,
        best: this.progress.best(quiz.key, def.stage),
        status,
      };
    });
  });

  // Every stage of the quiz is passed: the quiz is finished.
  protected readonly allPassed = computed(() => {
    const cards = this.cards();
    return cards.length > 0 && cards.every(card => card.status === 'passed');
  });

  protected readonly totalScore = computed(() =>
    this.cards().reduce((sum, card) => sum + (card.best?.correct ?? 0) * POINTS_PER_CORRECT, 0));

  protected readonly pointsPerCorrect = POINTS_PER_CORRECT;
  protected readonly timeModeLabels = TIME_MODE_LABELS;

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
