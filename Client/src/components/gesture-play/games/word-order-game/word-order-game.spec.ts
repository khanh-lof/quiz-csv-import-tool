import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GameAudio } from '../../../../game/game-audio';
import type { Choice, Point3, QuestionView, Reveal } from '../../../../game/stage-game';
import { WordOrderGame } from './word-order-game';

// Two tiles read 的, so the game has to tell tiles apart by position.
const QUESTION: QuestionView = {
  stage: 6,
  question: 'Đây là sách của anh ấy.',
  options: [],
  chunks: ['这', '是', '他', '的', '书', '的'],
};

// A 21-point hand with the wrist and middle knuckle fixed (so the pinch ratio has a hand size) and the
// index fingertip at (x, y) in the unmirrored camera image. The thumb tip is `gap` to its right.
function hand(x: number, y: number, gap = 0.4): Point3[] {
  const points: Point3[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  points[0] = { x: 0.5, y: 0.9, z: 0 };
  points[9] = { x: 0.5, y: 0.6, z: 0 };
  points[8] = { x, y, z: 0 };
  points[4] = { x: x + gap, y, z: 0 };
  return points;
}

describe('WordOrderGame', () => {
  let fixture: ComponentFixture<WordOrderGame>;
  let game: WordOrderGame;
  let chosen: Choice[];
  let host: HTMLElement;

  async function setup(inputs: { cameraActive?: boolean; question?: QuestionView } = {}) {
    TestBed.configureTestingModule({ imports: [WordOrderGame] });
    spyOn(TestBed.inject(GameAudio), 'play');
    fixture = TestBed.createComponent(WordOrderGame);
    game = fixture.componentInstance;
    host = fixture.nativeElement;
    // A stage of known size, since the game lays itself out inside whatever its host is.
    Object.assign(host.style, {
      position: 'fixed',
      inset: 'auto',
      left: '0',
      top: '0',
      width: '1000px',
      height: '562px',
    });
    fixture.componentRef.setInput('question', inputs.question ?? QUESTION);
    fixture.componentRef.setInput('cameraActive', inputs.cameraActive ?? false);
    chosen = [];
    game.choose.subscribe(choice => chosen.push(choice));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function pool(): HTMLElement[] {
    return Array.from(host.querySelectorAll<HTMLElement>('.pool .tile'));
  }

  function line(): HTMLElement[] {
    return Array.from(host.querySelectorAll<HTMLElement>('.line .tile'));
  }

  function lineText(): string[] {
    return line().map(tile => tile.textContent!.trim());
  }

  function click(element: Element): void {
    (element as HTMLElement).click();
    fixture.detectChanges();
  }

  function undoCard(): HTMLElement {
    return host.querySelector<HTMLElement>('.undo')!;
  }

  function press(key: string, init: KeyboardEventInit = {}): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    fixture.detectChanges();
  }

  function centreOf(id: string): { x: number; y: number } {
    const origin = host.getBoundingClientRect();
    const box = host.querySelector<HTMLElement>(`[data-target="${id}"]`)!.getBoundingClientRect();
    return { x: box.left - origin.left + box.width / 2, y: box.top - origin.top + box.height / 2 };
  }

  // Feeds the game a hand whose fingertip is at stage position (x, y), every 33 ms from `from` to `to`.
  // The camera is not running in tests, so the game maps the landmark by stretching it over the stage
  // and mirroring it.
  function holdAt(x: number, y: number, from: number, to: number, gap = 0.4): void {
    for (let now = from; now <= to; now += 33) {
      const landmarks = hand(1 - x / 1000, y / 562, gap);
      game.onFrame({ kind: 'hand', hand: { landmarks, gesture: null, gestureScore: 0 } }, now);
      game.tick(0.033, now);
    }
    fixture.detectChanges();
  }

  describe('with the mouse', () => {
    beforeEach(async () => {
      await setup();
    });

    it('shows one tile per chunk and an empty slot for each', () => {
      const texts = pool().map(tile => tile.textContent!.replace(/\d/g, '').trim());
      expect(texts).toEqual(QUESTION.chunks!);
      expect(host.querySelectorAll('.line .slot').length).toBe(6);
      expect(host.textContent).toContain('Đây là sách của anh ấy.');
    });

    it('moves a picked tile to the line and hides it in the pool', () => {
      click(pool()[2]);
      expect(lineText()).toEqual(['他']);
      expect(pool()[2].classList).toContain('gone');
      expect(host.querySelectorAll('.line .slot').length).toBe(5);
    });

    it('keeps equal chunks apart', () => {
      click(pool()[5]);
      click(pool()[3]);
      expect(lineText()).toEqual(['的', '的']);
      expect(pool()[3].classList).toContain('gone');
      expect(pool()[5].classList).toContain('gone');
    });

    it('sends only the clicked tile back to the pool', () => {
      click(pool()[0]);
      click(pool()[1]);
      click(pool()[2]);
      click(line()[1]);
      expect(lineText()).toEqual(['这', '他']);
      expect(pool()[1].classList).not.toContain('gone');
      expect(pool()[0].classList).toContain('gone');
    });

    it('undoes the last tile with the undo card and with Backspace', () => {
      click(pool()[0]);
      click(pool()[1]);
      click(undoCard());
      expect(lineText()).toEqual(['这']);
      press('Backspace');
      expect(lineText()).toEqual([]);
    });

    it('picks the n-th tile with the digit keys and ignores other keys', () => {
      press('3');
      press('1');
      press('a');
      expect(lineText()).toEqual(['他', '这']);
      // A tile already placed does nothing.
      press('3');
      expect(lineText()).toEqual(['他', '这']);
      // Keys with a modifier are not answers.
      press('2', { ctrlKey: true });
      expect(lineText()).toEqual(['他', '这']);
    });

    it('does not report a sentence before every tile is placed', () => {
      [0, 1, 2, 3, 4].forEach(index => click(pool()[index]));
      game.tick(0.016, 1000);
      game.tick(0.016, 2000);
      expect(chosen).toEqual([]);
    });

    it('reports the order once, a moment after the last tile is placed', () => {
      [0, 1, 2, 3, 4, 5].forEach(index => click(pool()[index]));
      game.tick(0.016, 1000);
      expect(chosen).toEqual([]);
      game.tick(0.016, 1300);
      expect(chosen).toEqual([]);
      game.tick(0.016, 1400);
      expect(chosen).toEqual([['这', '是', '他', '的', '书', '的']]);
      game.tick(0.016, 2000);
      expect(chosen.length).toBe(1);
    });

    it('lets the player take a tile back during the pause and reports the new order', () => {
      [0, 1, 2, 3, 4, 5].forEach(index => click(pool()[index]));
      game.tick(0.016, 1000);
      click(undoCard());
      game.tick(0.016, 1500);
      expect(chosen).toEqual([]);
      click(pool()[5]);
      game.tick(0.016, 1600);
      game.tick(0.016, 2000);
      expect(chosen).toEqual([['这', '是', '他', '的', '书', '的']]);
    });

    it('cannot change the sentence once it has been reported', () => {
      [0, 1, 2, 3, 4, 5].forEach(index => click(pool()[index]));
      game.tick(0.016, 1000);
      game.tick(0.016, 1400);
      click(undoCard());
      click(line()[0]);
      expect(lineText().length).toBe(6);
    });

    it('starts the next question from an empty line', () => {
      click(pool()[0]);
      click(pool()[1]);
      fixture.componentRef.setInput('question', { ...QUESTION, chunks: ['你', '好'] });
      fixture.detectChanges();
      expect(lineText()).toEqual([]);
      expect(pool().length).toBe(2);
    });

    it('shows the correct sentence and ignores input once judged', () => {
      click(pool()[0]);
      const reveal: Reveal = {
        chosen: ['这'],
        correct: false,
        correctOrder: ['这', '是', '他', '的', '书'],
      };
      fixture.componentRef.setInput('reveal', reveal);
      fixture.detectChanges();
      expect(host.querySelector('.solution')!.textContent).toContain('这是他的书');
      expect(host.querySelector('.line')!.classList).toContain('wrong');
      click(line()[0]);
      press('Backspace');
      expect(lineText()).toEqual(['这']);
    });

    it('marks a right answer green', () => {
      fixture.componentRef.setInput('reveal', { chosen: [], correct: true, correctOrder: ['这'] });
      fixture.detectChanges();
      expect(host.querySelector('.line')!.classList).toContain('right');
    });

    it('ignores input while paused', () => {
      fixture.componentRef.setInput('paused', true);
      fixture.detectChanges();
      click(pool()[0]);
      press('1');
      expect(lineText()).toEqual([]);
    });

    it('hides the cursor and the gesture hint without a camera', () => {
      expect(host.querySelector('.cursor')).toBeNull();
      expect(host.querySelector('.hint')!.textContent).not.toContain('ngón');
    });
  });

  describe('with the camera', () => {
    beforeEach(async () => {
      await setup({ cameraActive: true });
    });

    it('asks for a hand until one is seen', () => {
      expect(host.querySelector('.hint')!.textContent).toContain('Đưa tay vào khung hình');
      holdAt(500, 300, 0, 100);
      expect(host.querySelector('.hint')!.textContent).toContain('Chỉ ngón trỏ');
      expect(host.querySelector('.cursor')!.classList).toContain('visible');
    });

    it('picks a tile the fingertip rests on', () => {
      const { x, y } = centreOf('pool:2');
      holdAt(x, y, 0, 600);
      expect(lineText()).toEqual([]);
      holdAt(x, y, 633, 900);
      expect(lineText()).toEqual(['他']);
    });

    it('undoes once per dwell and cooldown when the cursor stays on the undo card', () => {
      [0, 1, 2].forEach(index => click(pool()[index]));
      const { x, y } = centreOf('undo');
      holdAt(x, y, 0, 1000);
      expect(lineText()).toEqual(['这', '是']);
      // The first pick was at about 700 ms, so the card is not offered again until about 1100 ms, and
      // then needs a whole dwell of its own.
      holdAt(x, y, 1033, 1500);
      expect(lineText()).toEqual(['这', '是']);
      holdAt(x, y, 1533, 1900);
      expect(lineText()).toEqual(['这']);
    });

    it('picks a tile with a pinch at once and takes a placed tile back with another', () => {
      const first = centreOf('pool:1');
      holdAt(first.x, first.y, 0, 200);
      holdAt(first.x, first.y, 233, 400, 0.01);
      expect(lineText()).toEqual(['是']);
      // Open the fingers, then pinch the tile on the line.
      holdAt(first.x, first.y, 433, 700);
      const placed = centreOf('line:0');
      holdAt(placed.x, placed.y, 733, 1000);
      holdAt(placed.x, placed.y, 1033, 1200, 0.01);
      expect(lineText()).toEqual([]);
    });

    it('does not pick while the cursor only passes over tiles', () => {
      const a = centreOf('pool:0');
      const b = centreOf('pool:1');
      holdAt(a.x, a.y, 0, 300);
      holdAt(b.x, b.y, 333, 600);
      holdAt(a.x, a.y, 633, 900);
      expect(lineText()).toEqual([]);
    });

    it('ignores the hand while judged', () => {
      click(pool()[0]);
      const reveal: Reveal = { chosen: ['这'], correct: false, correctOrder: ['这', '是'] };
      fixture.componentRef.setInput('reveal', reveal);
      fixture.detectChanges();
      const { x, y } = centreOf('line:0');
      holdAt(x, y, 0, 900);
      holdAt(x, y, 933, 1200, 0.01);
      expect(lineText()).toEqual(['这']);
      expect(chosen).toEqual([]);
    });
  });
});
