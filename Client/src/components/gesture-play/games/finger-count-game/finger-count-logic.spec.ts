import type { HandFrame, Point3 } from '../../../../game/stage-game';
import { HoldSelector } from '../../../../game/hold-select';
import {
  FINGER_HINT,
  FINGER_HOLD_MS,
  FINGER_STABLE_FRAMES,
  fingerBadge,
  fingerChoice,
  fingerKeyIndex,
  FingerReader,
  fingerStatus,
  FingerView,
  hasHanzi,
  IDLE_FINGER_VIEW,
  NO_HAND,
  sameFingerView,
} from './finger-count-logic';

// An upright hand with the first `extended` of the four long fingers (index first) up and the rest
// folded, like the hand in the gestures spec: wrist at the bottom, PIPs a quarter of the frame above.
function handWith(extended: number, thumbOut = false): HandFrame {
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
  if (thumbOut) {
    // The thumb stuck far out to the side, as a fist with the thumb out or an open hand.
    landmarks[4] = {
      x: 0.15,
      y: 0.3,
      z: 0
    };
  }
  return {
    landmarks,
    gesture: null,
    gestureScore: 0
  };
}

const NO_HAND_FRAME: HandFrame = {
  landmarks: null,
  gesture: null,
  gestureScore: 0
};

// Reads `frame` `times` times and returns the last reading.
function readTimes(reader: FingerReader, frame: HandFrame, times: number, aspect = 1): number {
  let reading = NO_HAND;
  for (let i = 0; i < times; i++) {
    reading = reader.read(frame, aspect);
  }
  return reading;
}

describe('FingerReader', () => {
  it('counts the extended fingers of a steady hand, 1 to 4', () => {
    for (const fingers of [1, 2, 3, 4]) {
      expect(readTimes(new FingerReader(), handWith(fingers), FINGER_STABLE_FRAMES)).toBe(fingers);
    }
  });

  it('reads a fist as 0 and no hand as NO_HAND', () => {
    const reader = new FingerReader();
    expect(readTimes(reader, handWith(0), FINGER_STABLE_FRAMES)).toBe(0);
    expect(readTimes(reader, NO_HAND_FRAME, FINGER_STABLE_FRAMES)).toBe(NO_HAND);
  });

  it('does not count the thumb', () => {
    expect(readTimes(new FingerReader(), handWith(0, true), FINGER_STABLE_FRAMES)).toBe(0);
    expect(readTimes(new FingerReader(), handWith(2, true), FINGER_STABLE_FRAMES)).toBe(2);
  });

  it('reports no hand until a count has been seen for several frames in a row', () => {
    const reader = new FingerReader();
    expect(reader.read(handWith(3), 1)).toBe(NO_HAND);
    expect(reader.read(handWith(3), 1)).toBe(NO_HAND);
    expect(reader.read(handWith(3), 1)).toBe(3);
  });

  it('keeps the count through a flicker shorter than the required frames', () => {
    const reader = new FingerReader();
    readTimes(reader, handWith(3), FINGER_STABLE_FRAMES);
    expect(reader.read(handWith(2), 1)).toBe(3);
    expect(reader.read(handWith(2), 1)).toBe(3);
    expect(reader.read(handWith(3), 1)).toBe(3);
    // Losing the hand for a frame or two is a flicker as well.
    expect(reader.read(NO_HAND_FRAME, 1)).toBe(3);
    expect(reader.read(handWith(3), 1)).toBe(3);
  });

  it('follows a real change of count', () => {
    const reader = new FingerReader();
    readTimes(reader, handWith(3), FINGER_STABLE_FRAMES);
    expect(readTimes(reader, handWith(1), FINGER_STABLE_FRAMES)).toBe(1);
  });

  it('measures in the same units on both axes for a wide video', () => {
    for (const fingers of [0, 1, 2, 3, 4]) {
      expect(readTimes(new FingerReader(), handWith(fingers), FINGER_STABLE_FRAMES, 16 / 9)).toBe(
        fingers,
      );
    }
  });

  it('forgets what it saw on reset', () => {
    const reader = new FingerReader();
    readTimes(reader, handWith(2), FINGER_STABLE_FRAMES);
    reader.reset();
    expect(reader.read(handWith(2), 1)).toBe(NO_HAND);
  });
});

describe('fingerChoice', () => {
  it('maps one to four fingers to the first to fourth option', () => {
    expect([1, 2, 3, 4].map(count => fingerChoice(count, 4))).toEqual([0, 1, 2, 3]);
  });

  it('treats a fist and no hand as neutral', () => {
    expect(fingerChoice(0, 4)).toBeNull();
    expect(fingerChoice(NO_HAND, 4)).toBeNull();
  });

  it('treats more fingers than there are options as neutral', () => {
    expect(fingerChoice(3, 3)).toBe(2);
    expect(fingerChoice(4, 3)).toBeNull();
    expect(fingerChoice(1, 0)).toBeNull();
  });
});

describe('finger-count decision per frame', () => {
  // The reader and the gate the game runs on every frame, driven by ~30 fps frames.
  interface Shot {
    at: number;
    frame: HandFrame;
  }

  function shots(frame: HandFrame, from: number, to: number): Shot[] {
    const out: Shot[] = [];
    for (let at = from; at <= to; at += 33) {
      out.push({
        at,
        frame
      });
    }
    return out;
  }

  function play(all: Shot[], optionCount = 4): number[] {
    const reader = new FingerReader();
    const selector = new HoldSelector(FINGER_HOLD_MS);
    const selected: number[] = [];
    for (const {
      at,
      frame
    } of all) {
      const step = selector.step(fingerChoice(reader.read(frame, 1), optionCount), at);
      if (step.selected !== undefined) {
        selected.push(step.selected);
      }
    }
    return selected;
  }

  it('selects the option of the finger count held for about 700 ms', () => {
    for (const fingers of [1, 2, 3, 4]) {
      const selected = play([
        ...shots(handWith(0), 0, 300),
        ...shots(handWith(fingers), 333, 1400),
      ]);
      expect(selected).toEqual([fingers - 1]);
    }
  });

  it('does not select while the hand is still rising through smaller counts', () => {
    const selected = play([
      ...shots(handWith(0), 0, 300),
      ...shots(handWith(1), 333, 450),
      ...shots(handWith(2), 483, 600),
      ...shots(handWith(3), 633, 1100),
    ]);
    // Three fingers were shown for under 700 ms, and 1 and 2 even less: nothing yet.
    expect(selected).toEqual([]);
  });

  it('selects the final count once the hand has settled', () => {
    const selected = play([
      ...shots(handWith(0), 0, 300),
      ...shots(handWith(1), 333, 450),
      ...shots(handWith(2), 483, 600),
      ...shots(handWith(3), 633, 1600),
    ]);
    expect(selected).toEqual([2]);
  });

  it('survives tracking flicker while the count is held', () => {
    const held = handWith(2);
    const selected = play([
      ...shots(handWith(0), 0, 300),
      ...shots(held, 333, 600),
      ...shots(handWith(3), 633, 666),
      ...shots(NO_HAND_FRAME, 699, 699),
      ...shots(held, 732, 1500),
    ]);
    expect(selected).toEqual([1]);
  });

  it('does not select a hand that was already up when the question began', () => {
    expect(play(shots(handWith(3), 0, 3000))).toEqual([]);
  });

  it('does not select a count that has no option', () => {
    const selected = play([...shots(handWith(0), 0, 300), ...shots(handWith(4), 333, 1500)], 3);
    expect(selected).toEqual([]);
  });
});

describe('badge and status', () => {
  const view = (partial: Partial<FingerView>): FingerView => ({ ...IDLE_FINGER_VIEW, ...partial });

  it('names what the camera sees', () => {
    expect(fingerBadge(NO_HAND)).toBe('Chưa thấy bàn tay');
    expect(fingerBadge(0)).toBe('Đang nắm tay');
    expect(fingerBadge(3)).toBe('Đang giơ: 3 ngón');
  });

  it('shows the charging card and the progress in percent', () => {
    expect(fingerStatus(view({
      armed: true,
      choice: 2,
      progress: 0.4,
      count: 3
    }))).toBe(
      'Đang chọn đáp án 3… 40%',
    );
  });

  it('asks for a fist while fingers are up and the gate is not armed', () => {
    expect(fingerStatus(view({
      armed: false,
      count: 2
    }))).toBe('Nắm tay lại rồi chọn câu tiếp');
  });

  it('shows the standing hint otherwise', () => {
    expect(fingerStatus(view({
      armed: true,
      count: 0
    }))).toBe(FINGER_HINT);
    expect(fingerStatus(view({
      armed: false,
      count: NO_HAND
    }))).toBe(FINGER_HINT);
    expect(FINGER_HINT).toBe('Giơ số ngón theo đáp án (không tính ngón cái)');
  });

  it('compares views by what is shown', () => {
    expect(sameFingerView(IDLE_FINGER_VIEW, { ...IDLE_FINGER_VIEW })).toBeTrue();
    expect(sameFingerView(IDLE_FINGER_VIEW, {
      ...IDLE_FINGER_VIEW,
      count: 2
    })).toBeFalse();
    expect(sameFingerView(IDLE_FINGER_VIEW, {
      ...IDLE_FINGER_VIEW,
      progress: 0.005
    })).toBeTrue();
    expect(sameFingerView(IDLE_FINGER_VIEW, {
      ...IDLE_FINGER_VIEW,
      progress: 0.2
    })).toBeFalse();
  });
});

describe('fingerKeyIndex', () => {
  it('maps 1 to 4 to the options that exist', () => {
    expect(['1', '2', '3', '4'].map(key => fingerKeyIndex(key, 4))).toEqual([0, 1, 2, 3]);
    expect(fingerKeyIndex('3', 3)).toBe(2);
    expect(fingerKeyIndex('4', 3)).toBeNull();
  });

  it('ignores every other key', () => {
    for (const key of ['0', '5', 'Enter', 'ArrowLeft', 'p', ' ', '']) {
      expect(fingerKeyIndex(key, 4)).toBeNull();
    }
  });
});

describe('hasHanzi', () => {
  it('detects hanzi, with or without pinyin', () => {
    expect(hasHanzi('再见')).toBeTrue();
    expect(hasHanzi('再见 (zàijiàn)')).toBeTrue();
    expect(hasHanzi('Tạm biệt')).toBeFalse();
    expect(hasHanzi('')).toBeFalse();
  });
});
