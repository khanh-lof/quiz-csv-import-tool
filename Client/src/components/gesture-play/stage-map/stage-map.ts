import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzPopconfirmDirective } from 'ng-zorro-antd/popconfirm';
import { NzRadioComponent, NzRadioGroupComponent } from 'ng-zorro-antd/radio';
import { NzSwitchComponent } from 'ng-zorro-antd/switch';
import { NzTagComponent } from 'ng-zorro-antd/tag';
import { DEFAULT_PASS_PERCENT, StageDef, stagePosition, STAGES } from '../../../game/stages';
import { passPercentOf, TIME_MODE_LABELS } from '../../../models/assignment';
import { GestureQuiz, questionCount } from '../../../models/gesture-quiz';
import { GestureProgressService, POINTS_PER_CORRECT, StageBest, } from '../../../services/gesture-progress.service';
import { GestureSettingsService, TimeMode } from '../gesture-settings.service';

// 'used' is an open stage whose runs are all spent (the teacher's replay limit).
type StageStatus = 'passed' | 'open' | 'locked' | 'used';

interface StageCard {
  def: StageDef;
  // The number the card shows ("Màn 2"): the stage's position among the stages the quiz has. `def.stage`
  // is still the stage's identity, which is what `start` emits.
  position: number;
  count: number;
  // The percentage of right answers that passes the stage: the teacher's for an assignment, else the default.
  percent: number;
  best: StageBest | null;
  status: StageStatus;
  // What the card says about the runs left under the teacher's limit; empty when there is no limit.
  attemptsText: string;
  // Whether the card can be opened: not locked, and not played out.
  playable: boolean;
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
  styleUrls: ['../game-themes.css', './stage-map.css']
})
export class GestureStageMap {
  readonly quiz = input.required<GestureQuiz>();
  // The teacher's time mode, when there is one: shown as text, since the student cannot change it.
  readonly lockedTimeMode = input<TimeMode | null>(null);
  // Whether the player may wipe the quiz's progress: not for a student, whose results are the teacher's.
  readonly allowReset = input(true);
  // Every stage with questions can be opened, passed or not (the teacher's preview).
  readonly allOpen = input(false);
  // The teacher's pass percentage of each stage, when there is one (an assignment).
  readonly passPercents = input<Record<string, number> | null>(null);
  // The runs each stage has left ("1" to "6"), when the teacher limited them (an assignment with a limit);
  // null when there is no limit, a stage at 0 cannot be opened.
  readonly attemptsLeft = input<Record<string, number> | null>(null);

  readonly start = output<number>();
  protected readonly total = computed(() => questionCount(this.quiz()));
  // The one percentage every stage shares (the summary can then say it), or null when the stages differ.
  protected readonly commonPercent = computed(() => {
    const percents = new Set(this.cards().map(card => card.percent));
    return percents.size === 1 ? [...percents][0] : null;
  });
  protected readonly defaultPercent = DEFAULT_PASS_PERCENT;
  // Every stage of the quiz is passed: the quiz is finished.
  protected readonly allPassed = computed(() => {
    const cards = this.cards();
    return cards.length > 0 && cards.every(card => card.status === 'passed');
  });
  protected readonly totalScore = computed(() =>
    this.cards().reduce((sum, card) => sum + (card.best?.correct ?? 0) * POINTS_PER_CORRECT, 0));
  protected readonly pointsPerCorrect = POINTS_PER_CORRECT;
  protected readonly timeModeLabels = TIME_MODE_LABELS;
  private readonly progress = inject(GestureProgressService);
  protected readonly cards = computed<StageCard[]>(() => {
    const quiz = this.quiz();
    return STAGES.filter(def => quiz.stages.has(def.stage)).map(def => {
      const left = this.attemptsLeft()?.[String(def.stage)] ?? null;
      const passed = this.progress.isPassed(quiz.key, def.stage);
      const open = this.allOpen() || this.progress.isUnlocked(quiz, def.stage);
      const status: StageStatus =
        passed ? 'passed' : open ? (left === 0 ? 'used' : 'open') : 'locked';
      return {
        def,
        position: stagePosition(quiz.stages.keys(), def.stage),
        count: quiz.stages.get(def.stage)?.length ?? 0,
        percent: passPercentOf(this.passPercents(), def.stage),
        best: this.progress.best(quiz.key, def.stage),
        status,
        // A stage the tag already calls "Hết lượt" does not say it twice.
        attemptsText: left === null ? '' : left > 0 ? `Còn ${left} lượt` : status === 'used' ? '' : 'Hết lượt',
        playable: status !== 'locked' && status !== 'used' && left !== 0,
      };
    });
  });
  private readonly settingsService = inject(GestureSettingsService);
  protected readonly settings = this.settingsService.settings;

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
