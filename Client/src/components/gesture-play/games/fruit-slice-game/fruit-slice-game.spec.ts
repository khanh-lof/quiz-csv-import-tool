import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GameAudio } from '../../../../game/game-audio';
import { Choice, QuestionView, Reveal, VisionFrame } from '../../../../game/stage-game';
import { FruitSliceGame } from './fruit-slice-game';
import { Fruit, FruitField } from './fruit-slice-physics';

const QUESTION: QuestionView = { stage: 4, question: '提高', options: ['水平', '任务', '观众'] };
const NEXT_QUESTION: QuestionView = { stage: 4, question: '解决', options: ['问题', '习惯', '比赛'] };

function press(key: string, init: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

// A hand whose index fingertip is at the given point of the camera image.
function handAt(x: number, y: number): VisionFrame {
  const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  landmarks[8] = { x, y, z: 0 };
  return { kind: 'hand', hand: { landmarks, gesture: null, gestureScore: 0 } };
}

const handLost: VisionFrame = {
  kind: 'hand',
  hand: { landmarks: null, gesture: null, gestureScore: 0 }
};

describe('FruitSliceGame', () => {
  let fixture: ComponentFixture<FruitSliceGame>;
  let game: FruitSliceGame;
  let field: FruitField;
  let emitted: Choice[];
  let play: jasmine.Spy;

  const set = (name: string, value: unknown) => {
    fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
  };

  // A fruit hanging in the middle of the stage, where a swipe can find it.
  function fruitAtCentre(slot: number): Fruit {
    const { width, height } = field.metrics;
    const fruit: Fruit = {
      slot,
      x: width / 2,
      y: height / 2,
      vx: 0,
      vy: 0,
      g: 0,
      r: 60,
      rot: 0,
      vr: 0,
      wait: 0,
      cut: false
    };
    field.fruits.push(fruit);
    return fruit;
  }

  beforeEach(async () => {
    play = jasmine.createSpy('play');
    TestBed.configureTestingModule({
      providers: [{ provide: GameAudio, useValue: { play, resume: () => undefined } }]
    });
    fixture = TestBed.createComponent(FruitSliceGame);
    game = fixture.componentInstance;
    fixture.componentRef.setInput('question', QUESTION);
    fixture.detectChanges();
    await fixture.whenStable();
    field = game['field'];
    emitted = [];
    game.choose.subscribe(choice => emitted.push(choice));
  });

  it('is a hand game', () => {
    expect(game.visionKind).toBe('hand');
    expect(game.ready()).toBeTrue();
    expect(field.ready).toBeTrue();
  });

  it('shows the question and the three answers in colour order', () => {
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.question-box')?.textContent).toContain('提高');
    const answers = Array.from(element.querySelectorAll('.answer'));
    expect(answers.map(a => a.getAttribute('data-slot'))).toEqual(['0', '1', '2']);
    expect(answers.map(a => a.querySelector('.fit')?.textContent)).toEqual(['水平', '任务', '观众']);
  });

  it('fits the text of the boxes', () => {
    const spans = Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('.fit'));
    expect(spans.length).toBe(4);
    for (const span of spans) {
      expect(parseFloat(span.style.fontSize)).toBeGreaterThan(0);
    }
  });

  describe('keys', () => {
    it('chooses the slot of the key, once per question', () => {
      press('2');
      press('3');
      press('1');
      expect(emitted).toEqual([1]);
    });

    it('accepts an answer again for the next question', () => {
      press('2');
      set('question', NEXT_QUESTION);
      press('3');
      expect(emitted).toEqual([1, 2]);
    });

    it('ignores keys that are not an answer', () => {
      press('4');
      press('0');
      press('a');
      press('Enter');
      expect(emitted).toEqual([]);
    });

    it('ignores modifier combinations, repeats and typing in an input', () => {
      press('1', { ctrlKey: true });
      press('1', { metaKey: true });
      press('1', { altKey: true });
      press('1', { repeat: true });
      const input = document.createElement('input');
      document.body.append(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
      input.remove();
      expect(emitted).toEqual([]);
    });

    it('ignores everything while paused or once the answer is judged', () => {
      set('paused', true);
      press('1');
      set('paused', false);
      set('reveal', { chosen: null, correct: false, correctIndex: 0 } satisfies Reveal);
      press('1');
      expect(emitted).toEqual([]);
    });

    it('cuts the fruit of that colour when it is in the air', () => {
      fruitAtCentre(1);
      press('2');
      expect(field.halves.length).toBe(2);
      expect(play).toHaveBeenCalledWith('slice');
      expect(emitted).toEqual([1]);
    });

    it('still answers when no fruit of that colour is in view', () => {
      press('3');
      expect(field.halves.length).toBe(0);
      expect(emitted).toEqual([2]);
    });
  });

  describe('fingertip', () => {
    beforeEach(() => set('cameraActive', true));

    // The camera is not mirrored in the landmarks but the preview is, so moving the fingertip from
    // x = 0.6 to x = 0.4 of the image sweeps the stage from left to right across its middle.
    function swipeAcrossTheMiddle(): void {
      game.onFrame(handAt(0.6, 0.5), 0);
      game.onFrame(handAt(0.4, 0.5), 33);
    }

    it('cuts the fruit a fast swipe crosses and answers with its colour', () => {
      fruitAtCentre(1);
      swipeAcrossTheMiddle();
      expect(emitted).toEqual([1]);
      expect(field.halves.length).toBe(2);
      expect(play).toHaveBeenCalledWith('slice');
    });

    it('answers only once, however many fruits are crossed afterwards', () => {
      fruitAtCentre(1);
      fruitAtCentre(2);
      swipeAcrossTheMiddle();
      game.onFrame(handAt(0.6, 0.5), 66);
      game.onFrame(handAt(0.4, 0.5), 99);
      expect(emitted.length).toBe(1);
    });

    it('does not cut on a slow drift over a fruit', () => {
      fruitAtCentre(1);
      game.onFrame(handAt(0.51, 0.5), 0);
      game.onFrame(handAt(0.5, 0.5), 33);
      game.onFrame(handAt(0.49, 0.5), 66);
      expect(emitted).toEqual([]);
      expect(field.fruits.length).toBe(1);
    });

    it('never cuts or answers while paused or judged', () => {
      fruitAtCentre(1);
      set('reveal', { chosen: null, correct: false, correctIndex: 0 } satisfies Reveal);
      swipeAcrossTheMiddle();
      expect(emitted).toEqual([]);
      expect(field.fruits.length).toBe(1);
    });

    it('drops the cursor when the hand leaves the picture', () => {
      game.onFrame(handAt(0.5, 0.5), 0);
      expect(game['cursor'].has).toBeTrue();
      game.onFrame(handLost, 50);
      expect(game['cursor'].has).toBeTrue();
      game.onFrame(handLost, 400);
      expect(game['cursor'].has).toBeFalse();
    });

    it('ignores frames of another kind', () => {
      game.onFrame(
        { kind: 'face', face: { faces: 0, landmarks: null, blendshapes: {} } },
        0
      );
      expect(game['cursor'].has).toBeFalse();
    });
  });

  describe('pointer', () => {
    let canvas: HTMLCanvasElement;

    function pointer(type: string, x: number, y: number): void {
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 7,
          pointerType: 'mouse',
          button: 0,
          clientX: rect.left + x,
          clientY: rect.top + y,
          bubbles: true,
          cancelable: true
        })
      );
    }

    beforeEach(() => {
      canvas = fixture.nativeElement.querySelector('canvas');
    });

    it('cuts the fruit a stroke crosses', () => {
      const fruit = fruitAtCentre(0);
      pointer('pointerdown', fruit.x - 150, fruit.y);
      pointer('pointermove', fruit.x - 80, fruit.y);
      pointer('pointermove', fruit.x - 20, fruit.y);
      pointer('pointerup', fruit.x - 20, fruit.y);
      expect(emitted).toEqual([0]);
      expect(field.halves.length).toBe(2);
    });

    it('does not count a short wiggle or a click as a swipe', () => {
      const fruit = fruitAtCentre(0);
      pointer('pointerdown', fruit.x, fruit.y);
      pointer('pointermove', fruit.x + 4, fruit.y);
      pointer('pointermove', fruit.x + 8, fruit.y);
      pointer('pointerup', fruit.x + 8, fruit.y);
      expect(emitted).toEqual([]);
      expect(field.fruits.length).toBe(1);
    });

    it('ignores a stroke that starts while the game is paused', () => {
      set('paused', true);
      const fruit = fruitAtCentre(0);
      pointer('pointerdown', fruit.x - 150, fruit.y);
      pointer('pointermove', fruit.x - 20, fruit.y);
      expect(emitted).toEqual([]);
    });
  });

  describe('animation', () => {
    it('throws waves of three fruits, a new one when at most one is left', () => {
      game.tick(0.016, 16);
      expect(field.fruits.length).toBe(3);
      field.fruits.length = 1;
      // The next wave follows after a short beat, not on the very next frame.
      game.tick(0.016, 32);
      expect(field.fruits.length).toBe(1);
      game.tick(0.2, 232);
      expect(field.fruits.length).toBe(4);
    });

    it('stops throwing once the answer is chosen, and keeps animating the pieces', () => {
      fruitAtCentre(1);
      press('2');
      field.fruits.length = 0;
      const before = field.halves.map(h => h.y);
      game.tick(0.05, 16);
      expect(field.fruits.length).toBe(0);
      expect(field.halves.map(h => h.y)).not.toEqual(before);
    });

    it('stops throwing once the answer is judged', () => {
      set('reveal', { chosen: null, correct: false, correctIndex: 2 } satisfies Reveal);
      game.tick(0.016, 16);
      expect(field.fruits.length).toBe(0);
    });

    it('clears the fruits but keeps the juice when the question changes', () => {
      fruitAtCentre(0);
      fruitAtCentre(1);
      press('1');
      expect(field.particles.length).toBeGreaterThan(0);
      set('question', NEXT_QUESTION);
      expect(field.fruits.length).toBe(0);
      expect(field.particles.length).toBeGreaterThan(0);
    });

    it('bursts sparkles for a correct answer only', () => {
      set('reveal', { chosen: 1, correct: false, correctIndex: 0 } satisfies Reveal);
      expect(field.particles.length).toBe(0);
      set('reveal', null);
      set('reveal', { chosen: 0, correct: true, correctIndex: 0 } satisfies Reveal);
      expect(field.particles.filter(p => p.type === 'star').length).toBeGreaterThan(0);
    });

    it('draws without errors', () => {
      fruitAtCentre(0);
      fruitAtCentre(2);
      press('1');
      expect(() => {
        game.tick(0.016, 16);
        game.tick(0.016, 32);
      }).not.toThrow();
    });
  });

  describe('answer boxes', () => {
    const boxes = () => Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('.answer'));

    it('outlines the box that was cut before the answer is judged', () => {
      press('2');
      fixture.detectChanges();
      expect(boxes().map(b => b.classList.contains('picked'))).toEqual([false, true, false]);
    });

    it('marks the right box and the wrong choice once judged', () => {
      press('1');
      set('reveal', { chosen: 0, correct: false, correctIndex: 2 } satisfies Reveal);
      const [first, second, third] = boxes();
      expect(first.classList).toContain('wrong');
      expect(second.classList).toContain('dim');
      expect(third.classList).toContain('correct');
    });

    it('clears the marks for the next question', () => {
      press('1');
      set('reveal', { chosen: 0, correct: true, correctIndex: 0 } satisfies Reveal);
      set('reveal', null);
      set('question', NEXT_QUESTION);
      for (const box of boxes()) {
        expect(box.classList).not.toContain('correct');
        expect(box.classList).not.toContain('dim');
        expect(box.classList).not.toContain('picked');
      }
    });
  });

  describe('hint', () => {
    const hint = () => fixture.nativeElement.querySelector('.hint')?.textContent?.trim() ?? '';

    it('tells a player without a camera how to cut, until they have', () => {
      expect(hint()).toContain('Kéo chuột');
      press('1');
      fixture.detectChanges();
      expect(hint()).toBe('');
    });

    it('asks for a finger while the camera sees no hand, then for a swipe', () => {
      set('cameraActive', true);
      expect(hint()).toBe('Đưa ngón trỏ vào khung hình');
      game.onFrame(handAt(0.5, 0.5), 0);
      fixture.detectChanges();
      expect(hint()).toContain('Vung ngón trỏ');
    });
  });
});
