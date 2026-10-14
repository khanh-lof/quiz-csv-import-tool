import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GameAudio } from '../../../../game/game-audio';
import type { HandFrame, QuestionView, Reveal } from '../../../../game/stage-game';
import { TrueFalseGame } from './true-false-game';

const QUESTION: QuestionView = {
  stage: 1,
  question: '你好 (nǐ hǎo) nghĩa là xin chào.',
  options: ['Đúng', 'Sai'],
};

const HAND = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
const THUMB_UP: HandFrame = { landmarks: HAND, gesture: 'Thumb_Up', gestureScore: 0.9 };
const THUMB_DOWN: HandFrame = { landmarks: HAND, gesture: 'Thumb_Down', gestureScore: 0.9 };
const NO_HAND: HandFrame = { landmarks: null, gesture: null, gestureScore: 0 };

describe('TrueFalseGame', () => {
  let fixture: ComponentFixture<TrueFalseGame>;
  let game: TrueFalseGame;
  let audio: jasmine.SpyObj<GameAudio>;
  let chosen: number[];

  const root = (): HTMLElement => fixture.nativeElement;
  const targets = (): HTMLElement[] => Array.from(root().querySelectorAll<HTMLElement>('.target'));
  const press = (key: string, init: KeyboardEventInit = {}) =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  const setInput = (name: string, value: unknown) => {
    fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
  };
  const show = (hand: HandFrame, from: number, to: number) => {
    for (let at = from; at <= to; at += 33) {
      game.onFrame({ kind: 'hand', hand }, at);
    }
    fixture.detectChanges();
  };
  const reveal = (value: Reveal) => setInput('reveal', value);

  beforeEach(async () => {
    audio = jasmine.createSpyObj<GameAudio>('GameAudio', ['play']);
    await TestBed.configureTestingModule({
      imports: [TrueFalseGame],
      providers: [{ provide: GameAudio, useValue: audio }],
    }).compileComponents();
    fixture = TestBed.createComponent(TrueFalseGame);
    game = fixture.componentInstance;
    chosen = [];
    game.choose.subscribe(choice => chosen.push(choice as number));
    fixture.componentRef.setInput('question', QUESTION);
    fixture.detectChanges();
  });

  it('shows the statement and the two targets, Đúng on the left and Sai on the right', () => {
    expect(root().querySelector('.statement')?.textContent).toContain('nghĩa là xin chào');
    expect(targets().map(target => target.querySelector('.label')?.textContent)).toEqual([
      'Đúng',
      'Sai',
    ]);
    expect(targets().map(target => target.querySelector('.emoji')?.textContent)).toEqual([
      '👍',
      '👎',
    ]);
  });

  it('answers with a click, once', () => {
    targets()[1].click();
    targets()[0].click();
    press('1');
    expect(chosen).toEqual([1]);
  });

  it('answers with the 1/← and 2/→ keys', () => {
    for (const [key, index] of [
      ['1', 0],
      ['ArrowLeft', 0],
      ['2', 1],
      ['ArrowRight', 1],
    ] as const) {
      const fresh = TestBed.createComponent(TrueFalseGame);
      const answers: number[] = [];
      fresh.componentInstance.choose.subscribe(choice => answers.push(choice as number));
      fresh.componentRef.setInput('question', QUESTION);
      fresh.detectChanges();
      press(key);
      expect(answers).withContext(key).toEqual([index]);
      fresh.destroy();
    }
  });

  it('ignores keys with a modifier, other keys, and keys typed into a text field', () => {
    press('1', { ctrlKey: true });
    press('2', { shiftKey: true });
    press('3');
    press('Enter');
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    input.remove();
    expect(chosen).toEqual([]);
  });

  it('ignores everything while paused', () => {
    setInput('paused', true);
    targets()[0].click();
    press('2');
    expect(chosen).toEqual([]);
    setInput('paused', false);
    press('2');
    expect(chosen).toEqual([1]);
  });

  it('ignores everything once the verdict is shown', () => {
    reveal({ chosen: 0, correct: true, correctIndex: 0 });
    targets()[1].click();
    press('2');
    show(THUMB_DOWN, 0, 3000);
    expect(chosen).toEqual([]);
  });

  it('highlights the right target, and the chosen one when it was wrong', () => {
    targets()[0].click();
    reveal({ chosen: 0, correct: false, correctIndex: 1 });
    expect(targets()[1].classList).toContain('correct');
    expect(targets()[1].querySelector('.mark')?.textContent).toBe('✓');
    expect(targets()[0].classList).toContain('wrong');
    expect(targets()[0].querySelector('.mark')?.textContent).toBe('✗');
  });

  it('only highlights the right target when the time ran out', () => {
    reveal({ chosen: null, correct: false, correctIndex: 0 });
    expect(targets()[0].classList).toContain('correct');
    expect(root().querySelectorAll('.wrong').length).toBe(0);
  });

  it('shows no camera hints without the camera', () => {
    expect(root().querySelector('.ring')).toBeNull();
    expect(root().querySelector('.status')).toBeNull();
  });

  describe('with the camera', () => {
    beforeEach(() => setInput('cameraActive', true));

    it('shows the instruction and a ring on each target', () => {
      expect(root().querySelectorAll('.ring').length).toBe(2);
      expect(root().querySelector('.status')?.textContent?.trim()).toBe(
        'Giơ ngón cái lên hoặc chúc xuống',
      );
    });

    it('answers Đúng after a thumb up has been held, with the charging sounds', () => {
      show(NO_HAND, 0, 300);
      show(THUMB_UP, 333, 700);
      expect(chosen).toEqual([]);
      expect(root().querySelector('.status')?.textContent).toContain('Đang chọn Đúng…');
      expect(targets()[0].classList).toContain('charging');
      expect(targets()[1].classList).not.toContain('charging');
      show(THUMB_UP, 733, 1500);
      expect(chosen).toEqual([0]);
      expect(audio.play.calls.allArgs().map(args => args[0])).toEqual([
        'select',
        'charge',
        'charge',
      ]);
    });

    it('answers Sai after a thumb down has been held', () => {
      show(NO_HAND, 0, 300);
      show(THUMB_DOWN, 333, 1500);
      expect(chosen).toEqual([1]);
    });

    it('does not answer a thumb that is dropped too soon', () => {
      show(NO_HAND, 0, 300);
      show(THUMB_UP, 333, 600);
      show(NO_HAND, 633, 1500);
      expect(chosen).toEqual([]);
      expect(root().querySelector('.status')?.textContent).toContain('Giơ ngón cái');
    });

    it('answers once, even if the thumb stays up and the verdict is slow', () => {
      show(NO_HAND, 0, 300);
      show(THUMB_UP, 333, 5000);
      expect(chosen).toEqual([0]);
    });

    it('needs the thumb dropped before the next question counts', () => {
      show(NO_HAND, 0, 300);
      show(THUMB_UP, 333, 1500);
      expect(chosen).toEqual([0]);

      // The next question: the player is still showing the old thumb.
      setInput('reveal', null);
      setInput('question', { ...QUESTION, question: 'Câu tiếp.' });
      show(THUMB_UP, 1600, 3500);
      expect(chosen).toEqual([0]);
      expect(root().querySelector('.status')?.textContent).toContain('Hạ tay xuống');

      show(NO_HAND, 3533, 3800);
      show(THUMB_DOWN, 3833, 4800);
      expect(chosen).toEqual([0, 1]);
    });

    it('does not read the camera while paused', () => {
      show(NO_HAND, 0, 300);
      setInput('paused', true);
      show(THUMB_UP, 333, 1500);
      expect(chosen).toEqual([]);
      expect(audio.play).not.toHaveBeenCalled();
    });

    it('ignores frames from the face task', () => {
      show(NO_HAND, 0, 300);
      for (let at = 333; at <= 1500; at += 33) {
        game.onFrame({ kind: 'face', face: { faces: 0, landmarks: null, blendshapes: {} } }, at);
      }
      expect(chosen).toEqual([]);
    });

    it('a click while a thumb is charging answers with the click', () => {
      show(NO_HAND, 0, 300);
      show(THUMB_UP, 333, 700);
      targets()[1].click();
      expect(chosen).toEqual([1]);
      show(THUMB_UP, 733, 2000);
      expect(chosen).toEqual([1]);
    });
  });

  describe('layout', () => {
    let stage: HTMLElement;

    // The page's stage: a positioned, clipped rectangle that the game fills.
    function mount(width: number, height: number): void {
      stage = document.createElement('div');
      stage.style.cssText = `position:relative;overflow:hidden;width:${width}px;height:${height}px`;
      document.body.appendChild(stage);
      stage.appendChild(root());
    }

    afterEach(() => stage?.remove());

    const rect = (selector: string) => root().querySelector(selector)!.getBoundingClientRect();

    for (const [width, height] of [
      [1280, 720],
      [800, 450],
      [360, 420],
    ]) {
      it(`keeps the statement above two targets at the sides of a ${width}x${height} stage`, () => {
        setInput('cameraActive', true);
        mount(width, height);
        const long = 'Câu dài hơn bình thường để thử xuống dòng: 你好 (nǐ hǎo) nghĩa là xin chào.';
        setInput('question', { ...QUESTION, question: long + ' ' + long });
        const area = stage.getBoundingClientRect();
        const statement = rect('.statement');
        const [left, right] = targets().map(target => target.getBoundingClientRect());
        const status = rect('.status');

        expect(statement.bottom).toBeLessThanOrEqual(left.top + 0.5);
        expect(left.right).toBeLessThanOrEqual(right.left);
        // The targets are at the screen's left and right and clear of its middle.
        expect(left.left - area.left).toBeLessThan(area.width * 0.1);
        expect(area.right - right.right).toBeLessThan(area.width * 0.1);
        expect(right.left - left.right).toBeGreaterThan(area.width * 0.15);
        expect(left.bottom).toBeLessThanOrEqual(status.top + 0.5);
        for (const box of [statement, left, right, status]) {
          expect(box.top).toBeGreaterThanOrEqual(area.top - 0.5);
          expect(box.bottom).toBeLessThanOrEqual(area.bottom + 0.5);
          expect(box.left).toBeGreaterThanOrEqual(area.left - 0.5);
          expect(box.right).toBeLessThanOrEqual(area.right + 0.5);
        }
        // Wide enough to tap or to aim at with a thumb.
        expect(left.width).toBeGreaterThan(100);
        expect(left.height).toBeGreaterThan(90);
      });
    }
  });
});
