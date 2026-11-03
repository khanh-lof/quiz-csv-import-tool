import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';
import { StageDef } from '../../../game/stages';

// A stage's card in its game's world: the scene with the game's icon across the top, its number and name
// below on white. It is the host button itself, so whoever places it decides what choosing it does: the
// stage map opens the stage, the AI form toggles the game. What the page puts inside goes under the name;
// an element marked `cardTag` goes on the scene beside the icon. The world's colours come from
// game-themes.css, which the placing component must list among its styles: the card sets data-game on its
// host, and only the placing component's encapsulated selectors reach the host element.
@Component({
  selector: 'button[ktQuizGestureStageCard]',
  templateUrl: './stage-card.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './stage-card.css',
  host: {
    class: 'stage-card',
    type: 'button',
    '[attr.data-game]': 'def().game',
    '[class.compact]': 'compact()',
  }
})
export class GestureStageCard {
  readonly def = input.required<StageDef>();
  // "Màn 2": the stage's position among the stages of the quiz; none when the stage is not in it.
  readonly label = input<string | null>(null);
  // A smaller scene and title, for a card that sits in a form rather than on the map.
  readonly compact = input(false, { transform: booleanAttribute });
}
