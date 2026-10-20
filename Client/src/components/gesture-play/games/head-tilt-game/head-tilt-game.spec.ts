import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GameAudio } from '../../../../game/game-audio';
import { Choice, QuestionView, Reveal } from '../../../../game/stage-game';
import { VisionService } from '../../../../game/vision.service';
import { faceFrame, FaceSpec, playFrames, VIDEO_HEIGHT, VIDEO_WIDTH } from './face-fixture';
import { HeadTiltGame } from './head-tilt-game';
import { RECALIBRATE_AFTER_MS } from './head-tilt-logic';

const QUESTION: QuestionView = {
  stage: 2,
  question: 'Từ nào có nghĩa là nước?',
  options: ['水 (shuǐ)', '茶 (chá)'],
};
const NEXT_QUESTION: QuestionView = {
  ...QUESTION,
  question: 'Từ nào có nghĩa là trà?'
};

describe('HeadTiltGame', () => {
  let fixture: ComponentFixture<HeadTiltGame>;
  let game: HeadTiltGame;
  let chosen: Choice[];
  let play: jasmine.Spy;

  beforeEach(() => {
    play = jasmine.createSpy('play');
    TestBed.configureTestingModule({
      providers: [
        {
          provide: GameAudio,
          useValue: { play }
        },
        {
          provide: VisionService,
          useValue: {
            videoSize: () => ({
              width: VIDEO_WIDTH,
              height: VIDEO_HEIGHT
            })
          },
        },
      ],
    });
    fixture = TestBed.createComponent(HeadTiltGame);
    game = fixture.componentInstance;
    chosen = [];
    game.choose.subscribe(choice => chosen.push(choice));
    fixture.componentRef.setInput('question', QUESTION);
    fixture.detectChanges();
  });

  function set(name: 'question' | 'reveal' | 'paused' | 'cameraActive', value: unknown): void {
    fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
  }

  function cards(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('button.card'));
  }

  function frames(spec: FaceSpec, from: number, durationMs: number): number {
    return playFrames(
      now => game.onFrame({
        kind: 'face',
        face: faceFrame(spec)
      }, now),
      from,
      durationMs,
    ).end;
  }

  function key(init: KeyboardEventInit, target: EventTarget = document): void {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true, ...init
    });
    target.dispatchEvent(event);
  }

  // Turns the camera on and looks straight at it for long enough to calibrate; returns the time.
  function calibrated(): number {
    set('cameraActive', true);
    const end = frames({}, 0, 1200);
    fixture.detectChanges();
    return end;
  }

  describe('without the camera', () => {
    it('is ready at once and shows the two options with the pinyin apart', () => {
      expect(game.ready()).toBeTrue();
      expect(cards().length).toBe(2);
      expect(cards()[0].querySelector('.word')!.textContent).toBe('水');
      expect(cards()[0].querySelector('.note')!.textContent).toBe('shuǐ');
      expect(fixture.nativeElement.querySelector('app-face-calibration')).toBeNull();
    });

    it('answers a click once and ignores more clicks for that question', () => {
      cards()[1].click();
      cards()[0].click();
      expect(chosen).toEqual([1]);

      set('question', NEXT_QUESTION);
      cards()[0].click();
      expect(chosen).toEqual([1, 0]);
    });

    it('answers the keys 1 / ← for the left card and 2 / → for the right one', () => {
      key({ key: '1' });
      expect(chosen).toEqual([0]);
      set('question', NEXT_QUESTION);
      key({ key: 'ArrowRight' });
      expect(chosen).toEqual([0, 1]);
      set('question', QUESTION);
      key({ key: 'ArrowLeft' });
      set('question', NEXT_QUESTION);
      key({ key: '2' });
      expect(chosen).toEqual([0, 1, 0, 1]);
    });

    it('ignores other keys, modifier keys and typing in an input', () => {
      key({ key: '3' });
      key({
        key: '1',
        ctrlKey: true
      });
      const input = document.createElement('input');
      document.body.appendChild(input);
      key({ key: '1' }, input);
      input.remove();
      expect(chosen).toEqual([]);
    });

    it('ignores everything while the answer is revealed or the game is paused', () => {
      set('paused', true);
      cards()[0].click();
      key({ key: '1' });
      expect(chosen).toEqual([]);

      set('paused', false);
      set('reveal', {
        chosen: 1,
        correct: false,
        correctIndex: 0
      } satisfies Reveal);
      cards()[0].click();
      key({ key: '2' });
      expect(chosen).toEqual([]);
    });

    it('marks the correct card and the wrong one that was chosen', () => {
      set('reveal', {
        chosen: 1,
        correct: false,
        correctIndex: 0
      } satisfies Reveal);
      expect(cards()[0].classList).toContain('correct');
      expect(cards()[0].textContent).toContain('✓');
      expect(cards()[1].classList).toContain('wrong');
      expect(cards()[1].textContent).toContain('✗');
    });
  });

  describe('with the camera', () => {
    it('is not ready until the player has looked at the camera for a second', () => {
      set('cameraActive', true);
      expect(game.ready()).toBeFalse();
      expect(fixture.nativeElement.querySelector('app-face-calibration .card')).not.toBeNull();

      const midway = frames({}, 0, 500);
      fixture.detectChanges();
      expect(game.ready()).toBeFalse();

      frames({}, midway, 700);
      fixture.detectChanges();
      expect(game.ready()).toBeTrue();
      expect(fixture.nativeElement.querySelector('app-face-calibration .card')).toBeNull();
      expect(fixture.nativeElement.querySelector('app-face-calibration button')).not.toBeNull();
    });

    it('does not calibrate with nobody or two people in front of the camera', () => {
      set('cameraActive', true);
      frames({ faces: 0 }, 0, 1500);
      frames({ faces: 2 }, 1600, 1500);
      expect(game.ready()).toBeFalse();
    });

    it('is ready when the camera goes off, and calibrates again when it comes back', () => {
      const end = calibrated();
      expect(game.ready()).toBeTrue();

      set('cameraActive', false);
      expect(game.ready()).toBeTrue();

      set('cameraActive', true);
      expect(game.ready()).toBeFalse();
      frames({}, end + 100, 1200);
      expect(game.ready()).toBeTrue();
    });

    it('calibrates again on request', () => {
      calibrated();
      const button: HTMLButtonElement = fixture.nativeElement.querySelector(
        'app-face-calibration button',
      );
      button.click();
      fixture.detectChanges();
      expect(game.ready()).toBeFalse();
    });

    it('answers the left card for a lean to the screen left, and only once', () => {
      let now = calibrated();
      now = frames({ roll: 0 }, now + 33, 400);
      now = frames({ roll: 14 }, now, 1500);

      expect(chosen).toEqual([0]);
      expect(play).toHaveBeenCalledWith('select');
    });

    it('answers the right card for a lean to the screen right', () => {
      let now = calibrated();
      now = frames({ roll: 0 }, now + 33, 400);
      frames({ roll: -14 }, now, 1500);

      expect(chosen).toEqual([1]);
    });

    it('does not answer while it is calibrating', () => {
      set('cameraActive', true);
      frames({ roll: 14 }, 0, 800);
      expect(chosen).toEqual([]);
    });

    it('needs the head back in the middle for each new question', () => {
      let now = calibrated();
      now = frames({}, now + 33, 400);
      now = frames({ roll: 14 }, now, 1200);
      expect(chosen).toEqual([0]);

      set('question', NEXT_QUESTION);
      now = frames({ roll: 14 }, now, 1500);
      expect(chosen).toEqual([0]);

      now = frames({}, now, 400);
      frames({ roll: -14 }, now, 1200);
      expect(chosen).toEqual([0, 1]);
    });

    it('calibrates again when the head stays off the middle, then answers from the new one', () => {
      let now = calibrated();
      // Settled 0.4 eye spans to one side since calibrating: the lean shows on the meter, but the
      // head never gets back to the old middle, so without a new calibration nothing would count.
      now = frames({ centerX: 0.58 }, now + 33, RECALIBRATE_AFTER_MS + 100);
      expect(game.ready()).toBeFalse();
      expect(chosen).toEqual([]);

      now = frames({ centerX: 0.58 }, now, 1200);
      expect(game.ready()).toBeTrue();
      now = frames({ centerX: 0.58 }, now, 400);
      frames({ centerX: 0.7 }, now, 900);
      expect(chosen).toEqual([0]);
    });

    it('ignores the head while the answer is revealed', () => {
      let now = calibrated();
      now = frames({}, now + 33, 400);
      set('reveal', {
        chosen: null,
        correct: false,
        correctIndex: 1
      } satisfies Reveal);
      frames({ roll: 14 }, now, 1500);
      expect(chosen).toEqual([]);
    });

    it('chooses nothing with two faces in view and says so', () => {
      let now = calibrated();
      now = frames({}, now + 33, 400);
      frames({
        roll: 14,
        faces: 2
      }, now, 1500);
      fixture.detectChanges();

      expect(chosen).toEqual([]);
      expect(fixture.nativeElement.querySelector('.hint.warn')!.textContent).toContain(
        'Chỉ một người',
      );
    });
  });
});
