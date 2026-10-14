import type { HandFrame, Point3 } from '../../../../game/stage-game';
import { HoldSelector } from '../../../../game/hold-select';
import {
  IDLE_THUMB_VIEW,
  THUMB_HOLD_MS,
  THUMB_TARGETS,
  ThumbReader,
  ThumbView,
  sameThumbView,
  thumbKeyIndex,
  thumbStatus,
} from './true-false-logic';

const HAND: Point3[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));

function frame(
  gesture: string | null,
  gestureScore = 0.9,
  landmarks: Point3[] | null = HAND,
): HandFrame {
  return { landmarks, gesture, gestureScore };
}

const NO_HAND: HandFrame = { landmarks: null, gesture: null, gestureScore: 0 };

describe('ThumbReader', () => {
  it('reads thumb up as 0 and thumb down as 1', () => {
    const up = new ThumbReader();
    up.read(frame('Thumb_Up'));
    expect(up.read(frame('Thumb_Up'))).toBe(0);
    const down = new ThumbReader();
    down.read(frame('Thumb_Down'));
    expect(down.read(frame('Thumb_Down'))).toBe(1);
  });

  it('does not believe a thumb on a single frame', () => {
    const reader = new ThumbReader();
    expect(reader.read(frame('Thumb_Up'))).toBeNull();
    expect(reader.read(frame('Thumb_Up'))).toBe(0);
  });

  it('ignores a thumb the recognizer is not sure about', () => {
    const reader = new ThumbReader();
    reader.read(frame('Thumb_Up', 0.5));
    expect(reader.read(frame('Thumb_Up', 0.5))).toBeNull();
    reader.read(frame('Thumb_Up', 0.6));
    expect(reader.read(frame('Thumb_Up', 0.6))).toBe(0);
  });

  it('treats other gestures and no hand as neutral', () => {
    const reader = new ThumbReader();
    reader.read(frame('Thumb_Up'));
    reader.read(frame('Thumb_Up'));
    reader.read(frame('Open_Palm', 0.99));
    expect(reader.read(frame('Open_Palm', 0.99))).toBeNull();
    reader.read(frame('Thumb_Down'));
    reader.read(frame('Thumb_Down'));
    reader.read(NO_HAND);
    expect(reader.read(NO_HAND)).toBeNull();
  });

  it('is not shaken by a one-frame misread in the middle of a thumb', () => {
    const reader = new ThumbReader();
    reader.read(frame('Thumb_Down'));
    reader.read(frame('Thumb_Down'));
    expect(reader.read(frame('Closed_Fist'))).toBe(1);
    expect(reader.read(frame('Thumb_Down'))).toBe(1);
    expect(reader.read(NO_HAND)).toBe(1);
    expect(reader.read(frame('Thumb_Down'))).toBe(1);
  });

  it('never reads a thumb from a frame without landmarks', () => {
    const reader = new ThumbReader();
    const ghost = frame('Thumb_Up', 0.99, null);
    reader.read(ghost);
    expect(reader.read(ghost)).toBeNull();
  });

  it('forgets what it saw on reset', () => {
    const reader = new ThumbReader();
    reader.read(frame('Thumb_Up'));
    reader.read(frame('Thumb_Up'));
    reader.reset();
    expect(reader.read(frame('Thumb_Up'))).toBeNull();
  });
});

describe('true/false decision per frame', () => {
  // The reader and the gate the game runs on every frame, driven by ~30 fps frames.
  function play(frames: Array<{ at: number; frame: HandFrame }>): Array<number | undefined> {
    const reader = new ThumbReader();
    const selector = new HoldSelector(THUMB_HOLD_MS);
    return frames.map(
      ({ at, frame: handFrame }) => selector.step(reader.read(handFrame), at).selected,
    );
  }

  function frames(
    frame: HandFrame,
    from: number,
    to: number,
  ): Array<{ at: number; frame: HandFrame }> {
    const out: Array<{ at: number; frame: HandFrame }> = [];
    for (let at = from; at <= to; at += 33) {
      out.push({ at, frame });
    }
    return out;
  }

  it('selects Đúng after a thumb up is held for about 600 ms', () => {
    const selected = play([...frames(NO_HAND, 0, 300), ...frames(frame('Thumb_Up'), 333, 1200)]);
    expect(selected.filter(value => value !== undefined)).toEqual([0]);
  });

  it('selects Sai after a thumb down is held', () => {
    const selected = play([...frames(NO_HAND, 0, 300), ...frames(frame('Thumb_Down'), 333, 1200)]);
    expect(selected.filter(value => value !== undefined)).toEqual([1]);
  });

  it('does not select a thumb that is shown for less than the hold', () => {
    const selected = play([
      ...frames(NO_HAND, 0, 300),
      ...frames(frame('Thumb_Up'), 333, 700),
      ...frames(NO_HAND, 733, 1500),
    ]);
    expect(selected.every(value => value === undefined)).toBeTrue();
  });

  it('does not answer with a thumb that is already up when the game starts', () => {
    const selected = play(frames(frame('Thumb_Up'), 0, 2000));
    expect(selected.every(value => value === undefined)).toBeTrue();
  });
});

describe('thumbStatus', () => {
  const view = (partial: Partial<ThumbView>): ThumbView => ({ ...IDLE_THUMB_VIEW, ...partial });

  it('shows the charging side and the progress in percent', () => {
    const charging = (choice: number, progress: number) =>
      thumbStatus(view({ armed: true, choice, progress }));
    expect(charging(0, 0.6)).toBe('Đang chọn Đúng… 60%');
    expect(charging(1, 0.333)).toBe('Đang chọn Sai… 33%');
  });

  it('asks the player to lower the hand while a thumb is up and the gate is not armed', () => {
    expect(thumbStatus(view({ armed: false, shown: 0 }))).toBe('Hạ tay xuống rồi chọn câu tiếp');
  });

  it('shows the instruction when there is nothing to choose', () => {
    expect(thumbStatus(view({ armed: true }))).toBe('Giơ ngón cái lên hoặc chúc xuống');
    // Waiting to be armed with the hand down is not worth a message.
    expect(thumbStatus(view({ armed: false }))).toBe('Giơ ngón cái lên hoặc chúc xuống');
  });
});

describe('thumbKeyIndex', () => {
  it('maps 1 and ← to Đúng and 2 and → to Sai', () => {
    expect(thumbKeyIndex('1')).toBe(0);
    expect(thumbKeyIndex('ArrowLeft')).toBe(0);
    expect(thumbKeyIndex('2')).toBe(1);
    expect(thumbKeyIndex('ArrowRight')).toBe(1);
  });

  it('ignores every other key', () => {
    expect(thumbKeyIndex('3')).toBeNull();
    expect(thumbKeyIndex('Enter')).toBeNull();
    expect(thumbKeyIndex('p')).toBeNull();
    expect(thumbKeyIndex('ArrowUp')).toBeNull();
  });
});

describe('targets and view', () => {
  it('puts Đúng (option 0) on the left and Sai (option 1) on the right', () => {
    expect(THUMB_TARGETS.map(target => [target.index, target.label])).toEqual([
      [0, 'Đúng'],
      [1, 'Sai'],
    ]);
  });

  it('compares views by what is shown', () => {
    expect(sameThumbView(IDLE_THUMB_VIEW, { ...IDLE_THUMB_VIEW })).toBeTrue();
    expect(sameThumbView(IDLE_THUMB_VIEW, { ...IDLE_THUMB_VIEW, shown: 1 })).toBeFalse();
    const half = { ...IDLE_THUMB_VIEW, progress: 0.5 };
    expect(sameThumbView(half, { ...half, progress: 0.51 })).toBeTrue();
    expect(sameThumbView(half, { ...half, progress: 0.6 })).toBeFalse();
  });
});
