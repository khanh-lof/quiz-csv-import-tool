import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GameAudio } from '../../../../game/game-audio';
import type { HandFrame, Point3, QuestionView, Reveal } from '../../../../game/stage-game';
import { VisionService } from '../../../../game/vision.service';
import { FingerCountGame } from './finger-count-game';

const QUESTION: QuestionView = {
  stage: 5,
  question: '再见 (zàijiàn) nghĩa là gì?',
  options: ['Tạm biệt', 'Xin chào', '谢谢 (xièxie)', 'Xin lỗi'],
};

// An upright hand with the first `extended` of the four long fingers up and the rest folded.
function hand(extended: number): HandFrame {
  const landmarks: Point3[] = Array.from({ length: 21 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0
  }));
  landmarks[0] = {
    x: 0.5,
    y: 0.9,
    z: 0
  };
  [
    [8, 6, 0.42],
    [12, 10, 0.48],
    [16, 14, 0.54],
    [20, 18, 0.6],
  ].forEach(([tip, pip, x], finger) => {
    landmarks[pip] = {
      x,
      y: 0.5,
      z: 0
    };
    landmarks[tip] = {
      x,
      y: finger < extended ? 0.28 : 0.6,
      z: 0
    };
  });
  return {
    landmarks,
    gesture: null,
    gestureScore: 0
  };
}

const NO_HAND: HandFrame = {
  landmarks: null,
  gesture: null,
  gestureScore: 0
};

describe('FingerCountGame', () => {
  let fixture: ComponentFixture<FingerCountGame>;
  let game: FingerCountGame;
  let audio: jasmine.SpyObj<GameAudio>;
  let chosen: number[];

  const root = (): HTMLElement => fixture.nativeElement;
  const cards = (): HTMLElement[] => Array.from(root().querySelectorAll<HTMLElement>('.card'));
  const press = (key: string, init: KeyboardEventInit = {}) =>
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      bubbles: true, ...init
    }));
  const setInput = (name: string, value: unknown) => {
    fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
  };
  const show = (frame: HandFrame, from: number, to: number) => {
    for (let at = from; at <= to; at += 33) {
      game.onFrame({
        kind: 'hand',
        hand: frame
      }, at);
    }
    fixture.detectChanges();
  };
  const reveal = (value: Reveal) => setInput('reveal', value);

  beforeEach(async () => {
    audio = jasmine.createSpyObj<GameAudio>('GameAudio', ['play']);
    await TestBed.configureTestingModule({
      imports: [FingerCountGame],
      providers: [
        {
          provide: GameAudio,
          useValue: audio
        },
        {
          provide: VisionService,
          useValue: {
            videoSize: () => ({
              width: 640,
              height: 480
            })
          }
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(FingerCountGame);
    game = fixture.componentInstance;
    chosen = [];
    game.choose.subscribe(choice => chosen.push(choice as number));
    fixture.componentRef.setInput('question', QUESTION);
    fixture.detectChanges();
  });

  it('shows the question and the four options, numbered 1 to 4', () => {
    expect(root().querySelector('.question')?.textContent).toContain('nghĩa là gì');
    expect(cards().map(card => card.querySelector('.digit')?.textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(cards().map(card => card.querySelector('.text')?.textContent)).toEqual(
      QUESTION.options,
    );
  });

  it('draws as many fingers up on a card as its number', () => {
    expect(cards().map(card => card.querySelectorAll('.finger.up').length)).toEqual([1, 2, 3, 4]);
    expect(cards().map(card => card.querySelectorAll('.finger').length)).toEqual([4, 4, 4, 4]);
  });

  it('sets only the options with hanzi in the hanzi font', () => {
    expect(cards().map(card => card.querySelector('.text')?.classList.contains('han'))).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it('answers with a click, once', () => {
    cards()[2].click();
    cards()[0].click();
    press('1');
    expect(chosen).toEqual([2]);
  });

  it('answers with the 1 to 4 keys', () => {
    for (const [key, index] of [
      ['1', 0],
      ['2', 1],
      ['3', 2],
      ['4', 3],
    ] as const) {
      const fresh = TestBed.createComponent(FingerCountGame);
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
    press('2', { altKey: true });
    press('5');
    press('0');
    press('ArrowLeft');
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: '3',
      bubbles: true
    }));
    input.remove();
    expect(chosen).toEqual([]);
  });

  it('ignores everything while paused', () => {
    setInput('paused', true);
    cards()[0].click();
    press('2');
    expect(chosen).toEqual([]);
    setInput('paused', false);
    press('2');
    expect(chosen).toEqual([1]);
  });

  it('ignores everything once the verdict is shown', () => {
    reveal({
      chosen: 0,
      correct: true,
      correctIndex: 0
    });
    cards()[1].click();
    press('2');
    show(hand(3), 0, 3000);
    expect(chosen).toEqual([]);
  });

  it('highlights the right card, and the chosen one when it was wrong', () => {
    cards()[1].click();
    reveal({
      chosen: 1,
      correct: false,
      correctIndex: 3
    });
    expect(cards()[3].classList).toContain('correct');
    expect(cards()[3].querySelector('.mark')?.textContent).toBe('✓');
    expect(cards()[1].classList).toContain('wrong');
    expect(cards()[1].querySelector('.mark')?.textContent).toBe('✗');
  });

  it('only highlights the right card when the time ran out', () => {
    reveal({
      chosen: null,
      correct: false,
      correctIndex: 2
    });
    expect(cards()[2].classList).toContain('correct');
    expect(root().querySelectorAll('.wrong').length).toBe(0);
  });

  it('shows no camera hints without the camera', () => {
    expect(root().querySelector('.ring')).toBeNull();
    expect(root().querySelector('.status')).toBeNull();
  });

  describe('with the camera', () => {
    beforeEach(() => setInput('cameraActive', true));

    const badge = () => root().querySelector('.badge')?.textContent?.trim();
    const hint = () => root().querySelector('.hint')?.textContent?.trim();

    it('shows the badge, the hint and a ring on each card', () => {
      expect(root().querySelectorAll('.ring').length).toBe(4);
      expect(badge()).toBe('Chưa thấy bàn tay');
      expect(hint()).toBe('Giơ số ngón theo đáp án (không tính ngón cái)');
    });

    it('shows how many fingers the camera counts', () => {
      show(hand(3), 0, 300);
      expect(badge()).toBe('Đang giơ: 3 ngón');
      show(hand(0), 333, 600);
      expect(badge()).toBe('Đang nắm tay');
      show(NO_HAND, 633, 900);
      expect(badge()).toBe('Chưa thấy bàn tay');
    });

    it('answers with the card of the finger count held, with the charging sounds', () => {
      show(hand(0), 0, 300);
      show(hand(3), 333, 800);
      expect(chosen).toEqual([]);
      expect(hint()).toContain('Đang chọn đáp án 3…');
      expect(cards()[2].classList).toContain('charging');
      expect(cards().filter(card => card.classList.contains('charging')).length).toBe(1);
      show(hand(3), 833, 1500);
      expect(chosen).toEqual([2]);
      expect(audio.play.calls.allArgs().map(args => args[0])).toEqual([
        'select',
        'charge',
        'charge',
      ]);
    });

    it('answers each card from its finger count', () => {
      for (const fingers of [1, 2, 3, 4]) {
        const fresh = TestBed.createComponent(FingerCountGame);
        const answers: number[] = [];
        fresh.componentInstance.choose.subscribe(choice => answers.push(choice as number));
        fresh.componentRef.setInput('question', QUESTION);
        fresh.componentRef.setInput('cameraActive', true);
        fresh.detectChanges();
        for (const [frame, from, to] of [
          [hand(0), 0, 300],
          [hand(fingers), 333, 1500],
        ] as const) {
          for (let at = from; at <= to; at += 33) {
            fresh.componentInstance.onFrame({
              kind: 'hand',
              hand: frame
            }, at);
          }
        }
        expect(answers).withContext(`${fingers} fingers`).toEqual([fingers - 1]);
        fresh.destroy();
      }
    });

    it('does not answer on a fist, no hand, or a count that is dropped too soon', () => {
      show(hand(0), 0, 600);
      show(NO_HAND, 633, 1200);
      show(hand(2), 1233, 1600);
      show(hand(0), 1633, 2400);
      expect(chosen).toEqual([]);
    });

    it('keeps the hold through a single odd frame', () => {
      show(hand(0), 0, 300);
      show(hand(2), 333, 600);
      show(hand(3), 633, 633);
      show(hand(2), 666, 1500);
      expect(chosen).toEqual([1]);
    });

    it('answers once, even if the hand stays up and the verdict is slow', () => {
      show(hand(0), 0, 300);
      show(hand(1), 333, 5000);
      expect(chosen).toEqual([0]);
    });

    it('needs a fist or no hand before the next question counts', () => {
      show(hand(0), 0, 300);
      show(hand(2), 333, 1500);
      expect(chosen).toEqual([1]);

      // The next question: the player is still showing two fingers.
      setInput('reveal', null);
      setInput('question', {
        ...QUESTION,
        question: 'Câu tiếp.'
      });
      show(hand(2), 1600, 3500);
      expect(chosen).toEqual([1]);
      expect(hint()).toBe('Nắm tay lại rồi chọn câu tiếp');

      show(hand(0), 3533, 3800);
      show(hand(4), 3833, 4800);
      expect(chosen).toEqual([1, 3]);
    });

    it('does not read the camera while paused', () => {
      show(hand(0), 0, 300);
      setInput('paused', true);
      show(hand(2), 333, 1500);
      expect(chosen).toEqual([]);
      expect(audio.play).not.toHaveBeenCalled();
    });

    it('ignores frames from the face task', () => {
      show(hand(0), 0, 300);
      for (let at = 333; at <= 1500; at += 33) {
        game.onFrame({
          kind: 'face',
          face: {
            faces: 0,
            landmarks: null,
            blendshapes: {}
          }
        }, at);
      }
      expect(chosen).toEqual([]);
    });

    it('a click while a hold is charging answers with the click', () => {
      show(hand(0), 0, 300);
      show(hand(3), 333, 800);
      cards()[0].click();
      expect(chosen).toEqual([0]);
      show(hand(3), 833, 2000);
      expect(chosen).toEqual([0]);
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
      setInput('cameraActive', true);
    }

    afterEach(() => stage?.remove());

    const boxes = () => cards().map(card => card.getBoundingClientRect());

    function expectInside(area: DOMRect, ...inner: DOMRect[]): void {
      for (const box of inner) {
        expect(box.top).toBeGreaterThanOrEqual(area.top - 0.5);
        expect(box.bottom).toBeLessThanOrEqual(area.bottom + 0.5);
        expect(box.left).toBeGreaterThanOrEqual(area.left - 0.5);
        expect(box.right).toBeLessThanOrEqual(area.right + 0.5);
      }
    }

    for (const [width, height] of [
      [1280, 720],
      [900, 450],
    ]) {
      it(`puts the four cards in a row under the question on a ${width}x${height} stage`, () => {
        mount(width, height);
        const area = stage.getBoundingClientRect();
        const question = root().querySelector('.question')!.getBoundingClientRect();
        const status = root().querySelector('.status')!.getBoundingClientRect();
        const row = boxes();

        expect(new Set(row.map(box => Math.round(box.top))).size).toBe(1);
        for (let i = 1; i < row.length; i++) {
          expect(row[i].left).toBeGreaterThanOrEqual(row[i - 1].right);
        }
        expect(question.bottom).toBeLessThanOrEqual(row[0].top + 0.5);
        expect(row[0].bottom).toBeLessThanOrEqual(status.top + 0.5);
        expectInside(area, question, status, ...row);
        // The cards leave the middle of the stage free for the player's hand: they are capped in
        // height and the question card is above them.
        expect(row[0].height).toBeLessThanOrEqual(262);
      });
    }

    for (const [width, height] of [
      [600, 450],
      [360, 560],
      [360, 420],
    ]) {
      it(`puts the four cards in a 2x2 grid under the question on a ${width}x${height} stage`, () => {
        mount(width, height);
        const area = stage.getBoundingClientRect();
        const question = root().querySelector('.question')!.getBoundingClientRect();
        const status = root().querySelector('.status')!.getBoundingClientRect();
        const [a, b, c, d] = boxes();

        expect(Math.round(a.top)).toBe(Math.round(b.top));
        expect(Math.round(c.top)).toBe(Math.round(d.top));
        expect(a.right).toBeLessThanOrEqual(b.left);
        expect(c.right).toBeLessThanOrEqual(d.left);
        expect(a.bottom).toBeLessThanOrEqual(c.top + 0.5);
        expect(question.bottom).toBeLessThanOrEqual(a.top + 0.5);
        expect(d.bottom).toBeLessThanOrEqual(status.top + 0.5);
        expectInside(area, question, status, a, b, c, d);
        // Big enough to tap, and tall enough for the pictogram, the digit and the text.
        expect(a.height).toBeGreaterThan(80);
        expect(a.width).toBeGreaterThan(120);
      });
    }

    it('wraps a long Vietnamese option inside its card', () => {
      mount(360, 560);
      setInput('question', {
        ...QUESTION,
        options: [
          'Một đáp án tiếng Việt rất dài cần phải xuống dòng nhiều lần trong thẻ',
          'Xin chào',
          '谢谢 (xièxie)',
          'Xin lỗi',
        ],
      });
      const text = root().querySelector('.text')!;
      expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
      expect(cards()[0].scrollHeight).toBeLessThanOrEqual(cards()[0].clientHeight + 1);
    });
  });
});
