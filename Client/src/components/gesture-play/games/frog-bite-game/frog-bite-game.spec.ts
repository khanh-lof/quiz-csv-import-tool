import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GameAudio } from '../../../../game/game-audio';
import { Choice, QuestionView, Reveal } from '../../../../game/stage-game';
import { VisionService } from '../../../../game/vision.service';
import { faceFrame, FaceSpec, NEUTRAL, playFrames, VIDEO_HEIGHT, VIDEO_WIDTH, } from '../head-tilt-game/face-fixture';
import { FrogBiteGame } from './frog-bite-game';

const QUESTION: QuestionView = {
  stage: 3,
  question: 'Từ nào có nghĩa là nước?',
  options: ['茶 (chá)', '水 (shuǐ)', '喝 (hē)'],
};
const NEXT_QUESTION: QuestionView = {
  ...QUESTION,
  question: 'Từ nào có nghĩa là uống?'
};

// Nose x for a head 0.75 eye spans toward the screen's right / left of the neutral one (the image is
// unmirrored, so the screen's right is a smaller x).
const RIGHT = NEUTRAL.noseX - 0.75 * NEUTRAL.eyeSpan;
const LEFT = NEUTRAL.noseX + 0.75 * NEUTRAL.eyeSpan;

describe('FrogBiteGame', () => {
  let fixture: ComponentFixture<FrogBiteGame>;
  let game: FrogBiteGame;
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
    fixture = TestBed.createComponent(FrogBiteGame);
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

  function frogLeft(): number {
    fixture.detectChanges();
    const frog: HTMLElement = fixture.nativeElement.querySelector('.frog');
    return parseFloat(frog.style.left);
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

  // The head at `noseX` for `restMs`, then the mouth open for 150 ms and shut again.
  function biteAt(noseX: number, from: number, restMs = 400): number {
    const settled = frames({
      noseX,
      centerX: noseX,
      jawOpen: 0.05
    }, from, restMs);
    const open = frames({
      noseX,
      centerX: noseX,
      jawOpen: 0.7
    }, settled, 150);
    return frames({
      noseX,
      centerX: noseX,
      jawOpen: 0.05
    }, open, 100);
  }

  function key(init: KeyboardEventInit, target: EventTarget = document): void {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true, ...init
    });
    target.dispatchEvent(event);
  }

  function calibrated(): number {
    set('cameraActive', true);
    const end = frames({}, 0, 1200);
    fixture.detectChanges();
    return end;
  }

  describe('without the camera', () => {
    it('is ready at once and shows an option in each of the three lanes', () => {
      expect(game.ready()).toBeTrue();
      expect(cards().length).toBe(3);
      expect(cards()[1].querySelector('.word')!.textContent).toBe('水');
      expect(cards()[1].querySelector('.note')!.textContent).toBe('shuǐ');
      expect(fixture.nativeElement.querySelector('app-face-calibration')).toBeNull();
      expect(fixture.nativeElement.querySelector('.frog')).not.toBeNull();
    });

    it('answers a click on a lane once, and the frog goes there with its tongue out', () => {
      cards()[2].click();
      cards()[0].click();
      fixture.detectChanges();

      expect(chosen).toEqual([2]);
      expect(frogLeft()).toBeCloseTo((2.5 / 3) * 100, 3);
      expect(fixture.nativeElement.querySelectorAll('.tongue').length).toBe(1);
      expect(play).toHaveBeenCalledWith('slice');

      set('question', NEXT_QUESTION);
      expect(fixture.nativeElement.querySelectorAll('.tongue').length).toBe(0);
      cards()[0].click();
      expect(chosen).toEqual([2, 0]);
    });

    it('answers the keys 1, 2 and 3', () => {
      key({ key: '3' });
      set('question', NEXT_QUESTION);
      key({ key: '2' });
      set('question', QUESTION);
      key({ key: '1' });
      expect(chosen).toEqual([2, 1, 0]);
    });

    it('moves the frog with the arrow keys and bites on Space', () => {
      expect(frogLeft()).toBeCloseTo(50, 3);
      key({ key: 'ArrowRight' });
      expect(frogLeft()).toBeCloseTo((2.5 / 3) * 100, 3);
      key({ key: 'ArrowRight' });
      expect(frogLeft()).toBeCloseTo((2.5 / 3) * 100, 3);
      key({ key: 'ArrowLeft' });
      key({ key: 'ArrowLeft' });
      expect(frogLeft()).toBeCloseTo((0.5 / 3) * 100, 3);
      key({ key: 'ArrowDown' });
      expect(frogLeft()).toBeCloseTo(50, 3);
      key({ key: 'ArrowLeft' });
      expect(chosen).toEqual([]);

      key({ key: ' ' });
      expect(chosen).toEqual([0]);
    });

    it('ignores other keys, modifier keys and typing in an input', () => {
      key({ key: '4' });
      key({
        key: '1',
        ctrlKey: true
      });
      const input = document.createElement('input');
      document.body.appendChild(input);
      key({ key: '2' }, input);
      input.remove();
      expect(chosen).toEqual([]);
    });

    it('ignores everything while the answer is revealed or the game is paused', () => {
      set('paused', true);
      cards()[0].click();
      key({ key: '1' });
      key({ key: ' ' });
      expect(chosen).toEqual([]);

      set('paused', false);
      set('reveal', {
        chosen: 0,
        correct: false,
        correctIndex: 1
      } satisfies Reveal);
      cards()[2].click();
      key({ key: '3' });
      expect(chosen).toEqual([]);
    });

    it('marks the correct lane and the wrong one that was chosen', () => {
      set('reveal', {
        chosen: 2,
        correct: false,
        correctIndex: 1
      } satisfies Reveal);
      expect(cards()[1].classList).toContain('correct');
      expect(cards()[1].textContent).toContain('✓');
      expect(cards()[2].classList).toContain('wrong');
      expect(cards()[2].textContent).toContain('✗');
      expect(cards()[0].classList).not.toContain('correct');
    });
  });

  describe('with the camera', () => {
    it('is not ready until the player has looked at the camera for a second', () => {
      set('cameraActive', true);
      expect(game.ready()).toBeFalse();
      expect(fixture.nativeElement.querySelector('app-face-calibration .card')).not.toBeNull();

      const midway = frames({}, 0, 500);
      expect(game.ready()).toBeFalse();
      frames({}, midway, 700);
      fixture.detectChanges();
      expect(game.ready()).toBeTrue();
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

    it('moves the frog with the head: right on the screen is the right lane', () => {
      let now = calibrated();
      now = frames({
        noseX: RIGHT,
        centerX: RIGHT
      }, now + 33, 400);
      expect(frogLeft()).toBeCloseTo((2.5 / 3) * 100, 3);
      expect(play).toHaveBeenCalledWith('select');

      now = frames({
        noseX: LEFT,
        centerX: LEFT
      }, now, 400);
      expect(frogLeft()).toBeCloseTo((0.5 / 3) * 100, 3);
    });

    it('bites the lane the head is in when the mouth opens and shuts', () => {
      let now = calibrated();
      now = biteAt(RIGHT, now + 33);
      expect(chosen).toEqual([2]);

      // Biting again for the same question does nothing.
      biteAt(RIGHT, now);
      expect(chosen).toEqual([2]);
    });

    it('answers nothing while it is calibrating', () => {
      set('cameraActive', true);
      biteAt(RIGHT, 0, 100);
      expect(chosen).toEqual([]);
    });

    it('does not count a bite right after the head arrives in a lane', () => {
      let now = calibrated();
      now = frames({ jawOpen: 0.05 }, now + 33, 400);
      biteAt(RIGHT, now, 0);
      expect(chosen).toEqual([]);
    });

    it('needs the mouth closed again for each new question', () => {
      let now = calibrated();
      now = biteAt(RIGHT, now + 33);
      expect(chosen).toEqual([2]);

      set('question', NEXT_QUESTION);
      // The mouth is still open when the question appears, and shuts: that is not a bite.
      now = frames({
        noseX: RIGHT,
        centerX: RIGHT,
        jawOpen: 0.7
      }, now, 400);
      now = frames({
        noseX: RIGHT,
        centerX: RIGHT,
        jawOpen: 0.05
      }, now, 200);
      expect(chosen).toEqual([2]);

      biteAt(RIGHT, now, 100);
      expect(chosen).toEqual([2, 2]);
    });

    it('ignores the arrow keys, which would only fight the head', () => {
      calibrated();
      key({ key: 'ArrowRight' });
      expect(frogLeft()).toBeCloseTo(50, 3);
    });

    it('ignores the head while the answer is revealed', () => {
      let now = calibrated();
      now = frames({ jawOpen: 0.05 }, now + 33, 400);
      set('reveal', {
        chosen: null,
        correct: false,
        correctIndex: 1
      } satisfies Reveal);
      biteAt(RIGHT, now);
      expect(chosen).toEqual([]);
    });

    it('chooses nothing with two faces in view and says so', () => {
      let now = calibrated();
      now = frames({ jawOpen: 0.05 }, now + 33, 400);
      frames({
        noseX: RIGHT,
        jawOpen: 0.7,
        faces: 2
      }, now, 600);
      fixture.detectChanges();

      expect(chosen).toEqual([]);
      expect(fixture.nativeElement.querySelector('.hint.warn')!.textContent).toContain(
        'Chỉ một người',
      );
    });

    it('answers a click as well while the camera is on', () => {
      calibrated();
      cards()[0].click();
      expect(chosen).toEqual([0]);
    });
  });
});
