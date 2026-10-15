import {
  HoldCues,
  HoldSelector,
  HoldSelectorStep,
  isPlainKey,
  isTypingTarget,
  ringOffset,
  sameProgress,
  StableReading,
} from './hold-select';

// Feeds `choice` to the selector every 20 ms from `from` to `to` (inclusive) and returns the steps.
function feed(
  selector: HoldSelector,
  choice: number | null,
  from: number,
  to: number,
): HoldSelectorStep[] {
  const steps: HoldSelectorStep[] = [];
  for (let now = from; now <= to; now += 20) {
    steps.push(selector.step(choice, now));
  }
  return steps;
}

describe('StableReading', () => {
  it('keeps the initial value until a new one has been seen the required number of times', () => {
    const reading = new StableReading<number>(-1, 3);
    expect(reading.step(2)).toBe(-1);
    expect(reading.step(2)).toBe(-1);
    expect(reading.step(2)).toBe(2);
    expect(reading.step(2)).toBe(2);
  });

  it('ignores a flicker shorter than the required number of frames', () => {
    const reading = new StableReading<number>(0, 3);
    [3, 3, 3].forEach(value => reading.step(value));
    expect(reading.step(2)).toBe(3);
    expect(reading.step(2)).toBe(3);
    expect(reading.step(3)).toBe(3);
    expect(reading.step(3)).toBe(3);
  });

  it('restarts the count when the reading changes in between', () => {
    const reading = new StableReading<number>(0, 3);
    reading.step(1);
    reading.step(1);
    reading.step(2);
    expect(reading.step(2)).toBe(0);
    expect(reading.step(2)).toBe(2);
  });

  it('works with null and goes back to the initial value on reset', () => {
    const reading = new StableReading<number | null>(null, 2);
    reading.step(1);
    expect(reading.step(1)).toBe(1);
    reading.step(null);
    expect(reading.step(null)).toBeNull();
    reading.step(1);
    reading.step(1);
    reading.reset();
    expect(reading.step(1)).toBeNull();
  });

  it('believes every reading at once with a single frame', () => {
    const reading = new StableReading<number>(0, 1);
    expect(reading.step(4)).toBe(4);
    expect(reading.step(1)).toBe(1);
  });
});

describe('HoldCues', () => {
  it('plays select when a hold starts, then charge at a third and two thirds', () => {
    const cues = new HoldCues();
    expect(cues.step(0, 0)).toBeNull();
    expect(cues.step(0, 0.05)).toBe('select');
    expect(cues.step(0, 0.2)).toBeNull();
    expect(cues.step(0, 0.34)).toBe('charge');
    expect(cues.step(0, 0.5)).toBeNull();
    expect(cues.step(0, 0.67)).toBe('charge');
    expect(cues.step(0, 0.9)).toBeNull();
    // The last third ends in the selection, which has its own sound.
    expect(cues.step(0, 1)).toBeNull();
  });

  it('plays select again for a different choice, and after the hold was dropped', () => {
    const cues = new HoldCues();
    expect(cues.step(0, 0.1)).toBe('select');
    expect(cues.step(1, 0.1)).toBe('select');
    expect(cues.step(null, 0)).toBeNull();
    expect(cues.step(1, 0.1)).toBe('select');
  });

  it('does not play a charge right after select when the hold starts already past a third', () => {
    const cues = new HoldCues();
    expect(cues.step(2, 0.4)).toBe('select');
    expect(cues.step(2, 0.45)).toBeNull();
    expect(cues.step(2, 0.7)).toBe('charge');
  });
});

describe('HoldSelector', () => {
  it('needs the neutral pose before a choice counts, then selects after the hold time', () => {
    const selector = new HoldSelector(600);
    // A pose held from the start never selects: the gate is not armed yet.
    expect(feed(selector, 0, 0, 1000).some(step => step.selected !== undefined)).toBeFalse();
    // Neutral for 200 ms arms it; holding 0 then selects it, and 0 counts as a selection.
    feed(selector, null, 1020, 1300);
    const steps = feed(selector, 0, 1320, 2000);
    const selected = steps.filter(step => step.selected !== undefined);
    expect(selected.length).toBe(1);
    expect(selected[0].selected).toBe(0);
    expect(selected[0].progress).toBe(1);
  });

  it('reports the sounds of a hold: one select, then two charges', () => {
    const selector = new HoldSelector(600);
    feed(selector, null, 0, 300);
    const cues = feed(selector, 1, 320, 1000)
      .map(step => step.cue)
      .filter(cue => cue !== null);
    expect(cues).toEqual(['select', 'charge', 'charge']);
  });

  it('does not select a pose that is dropped before the hold is complete', () => {
    const selector = new HoldSelector(600);
    feed(selector, null, 0, 300);
    const held = feed(selector, 1, 320, 700);
    expect(held.every(step => step.selected === undefined)).toBeTrue();
    expect(held[held.length - 1].progress).toBeGreaterThan(0.3);
    const dropped = feed(selector, null, 720, 1400);
    expect(dropped.every(step => step.selected === undefined)).toBeTrue();
    expect(dropped[dropped.length - 1].progress).toBe(0);
  });

  it('survives a flicker of a frame or two in the middle of a hold', () => {
    const selector = new HoldSelector(600);
    feed(selector, null, 0, 300);
    feed(selector, 1, 320, 520);
    selector.step(null, 540);
    selector.step(null, 560);
    const rest = feed(selector, 1, 580, 1000);
    expect(rest.some(step => step.selected === 1)).toBeTrue();
  });

  it('has to be armed by the neutral pose again after lock(), as on every new question', () => {
    const selector = new HoldSelector(600);
    feed(selector, null, 0, 300);
    selector.lock();
    // The player is still showing the pose of the last answer: nothing is selected.
    expect(feed(selector, 0, 320, 1500).some(step => step.selected !== undefined)).toBeFalse();
    feed(selector, null, 1520, 1800);
    expect(feed(selector, 0, 1820, 2600).some(step => step.selected === 0)).toBeTrue();
  });

  it('is not armed right after selecting', () => {
    const selector = new HoldSelector(600);
    feed(selector, null, 0, 300);
    const steps = feed(selector, 0, 320, 1000);
    const index = steps.findIndex(step => step.selected !== undefined);
    expect(index).toBeGreaterThan(-1);
    expect(steps[index + 1].armed).toBeFalse();
    expect(steps[index + 1].choice).toBeNull();
  });
});

describe('key and target checks', () => {
  const plain = {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false
  };

  it('lets a plain key on the page through', () => {
    expect(isPlainKey({
      ...plain,
      target: document.body
    })).toBeTrue();
    expect(isPlainKey({
      ...plain,
      target: null
    })).toBeTrue();
  });

  it('refuses a key with a modifier', () => {
    expect(isPlainKey({
      ...plain,
      ctrlKey: true,
      target: document.body
    })).toBeFalse();
    expect(isPlainKey({
      ...plain,
      metaKey: true,
      target: document.body
    })).toBeFalse();
    expect(isPlainKey({
      ...plain,
      altKey: true,
      target: document.body
    })).toBeFalse();
    expect(isPlainKey({
      ...plain,
      shiftKey: true,
      target: document.body
    })).toBeFalse();
  });

  it('refuses a key typed into a text field', () => {
    expect(isTypingTarget(document.createElement('input'))).toBeTrue();
    expect(isTypingTarget(document.createElement('textarea'))).toBeTrue();
    expect(isTypingTarget(document.createElement('select'))).toBeTrue();
    expect(isTypingTarget(document.createElement('button'))).toBeFalse();
    expect(isTypingTarget(document.createElement('div'))).toBeFalse();
    expect(isTypingTarget(null)).toBeFalse();
  });
});

describe('ring and view helpers', () => {
  it('draws the ring on the charged target only', () => {
    const view = {
      armed: true,
      choice: 1,
      progress: 0.25
    };
    expect(ringOffset(view, 1)).toBeCloseTo(75);
    expect(ringOffset(view, 0)).toBe(100);
    expect(ringOffset({
      armed: true,
      choice: 0,
      progress: 1
    }, 0)).toBe(0);
    expect(ringOffset({
      armed: true,
      choice: null,
      progress: 0
    }, 0)).toBe(100);
  });

  it('keeps the offset within the circle', () => {
    expect(ringOffset({
      armed: true,
      choice: 0,
      progress: 3
    }, 0)).toBe(0);
    expect(ringOffset({
      armed: true,
      choice: 0,
      progress: -1
    }, 0)).toBe(100);
  });

  it('treats progress within two percent as the same', () => {
    expect(sameProgress(0.5, 0.505)).toBeTrue();
    expect(sameProgress(0.5, 0.56)).toBeFalse();
    expect(sameProgress(0, 0)).toBeTrue();
  });
});
