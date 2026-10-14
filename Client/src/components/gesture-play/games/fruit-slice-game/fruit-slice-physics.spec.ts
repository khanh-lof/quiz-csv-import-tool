import {
  apexOf,
  findSlice,
  Fruit,
  FruitField,
  HAND_JUMP,
  HAND_MIN_SPEED,
  HandCursor,
  Rng,
  shuffle,
  SLOTS,
  spawnWave,
  StageMetrics
} from './fruit-slice-physics';

// A small seeded generator (mulberry32), so a failing geometry case can be reproduced.
function seeded(seed: number): Rng {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAGE: StageMetrics = { width: 1000, height: 600, playTop: 120, radius: 60 };

function fruit(overrides: Partial<Fruit> = {}): Fruit {
  return {
    slot: 0,
    x: 500,
    y: 300,
    vx: 0,
    vy: 0,
    g: 900,
    r: 50,
    rot: 0,
    vr: 0,
    wait: 0,
    cut: false,
    ...overrides
  };
}

describe('shuffle', () => {
  it('returns a permutation and leaves its input alone', () => {
    const input = [1, 2, 3, 4, 5];
    const result = shuffle(input, seeded(3));
    expect([...result].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('spawnWave', () => {
  it('throws one fruit per slot', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const wave = spawnWave(STAGE, 3, seeded(seed));
      expect(wave.map(f => f.slot).sort()).toEqual([0, 1, 2]);
    }
  });

  it('throws fewer fruits when the question has fewer answers', () => {
    expect(spawnWave(STAGE, 2, seeded(5)).map(f => f.slot).sort()).toEqual([0, 1]);
    expect(spawnWave(STAGE, 9, seeded(5)).length).toBe(SLOTS.length);
  });

  it('starts every fruit below the bottom edge, out of sight', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const f of spawnWave(STAGE, 3, seeded(seed))) {
        expect(f.y - f.r).toBeGreaterThan(STAGE.height);
        expect(f.wait).toBeGreaterThanOrEqual(0);
        expect(f.cut).toBeFalse();
      }
    }
  });

  it('lets every fruit peak inside the play area, below the question row', () => {
    const lowestApex = STAGE.playTop + (STAGE.height - STAGE.playTop) * 0.42;
    for (let seed = 1; seed <= 40; seed++) {
      for (const f of spawnWave(STAGE, 3, seeded(seed))) {
        const apex = apexOf(f);
        // The whole fruit, not just its centre, stays under the top row at the peak.
        expect(apex.y - f.r).toBeGreaterThanOrEqual(STAGE.playTop);
        expect(apex.y).toBeLessThanOrEqual(Math.max(lowestApex, STAGE.playTop + f.r * 1.15 + 10));
        expect(apex.x - f.r).toBeGreaterThanOrEqual(0);
        expect(apex.x + f.r).toBeLessThanOrEqual(STAGE.width);
      }
    }
  });

  it('sends the three fruits to three different thirds of the width', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const thirds = spawnWave(STAGE, 3, seeded(seed)).map(f =>
        Math.floor((apexOf(f).x / STAGE.width) * 3)
      );
      expect(thirds.sort()).toEqual([0, 1, 2]);
    }
  });

  it('actually reaches its apex when simulated', () => {
    const field = new FruitField(seeded(11));
    field.resize(STAGE.width, STAGE.height, STAGE.playTop);
    field.step(0, true);
    const wave = field.fruits.map(f => ({ f, apex: apexOf(f), top: Infinity }));
    // Small steps: the game's own integrator is a little biased at 60 fps (the fruit peaks a few
    // pixels lower than planned, which is the safe side), and that bias grows with the step.
    for (let i = 0; i < 1500; i++) {
      field.step(0.002, false);
      for (const item of wave) {
        item.top = Math.min(item.top, item.f.y);
      }
    }
    for (const item of wave) {
      expect(Math.abs(item.top - item.apex.y)).toBeLessThan(3);
    }
  });
});

describe('findSlice', () => {
  const height = 600;

  it('hits a fruit that the segment passes through', () => {
    const hit = findSlice([fruit()], { ax: 400, ay: 300, bx: 600, by: 300 }, height);
    expect(hit?.fruit.slot).toBe(0);
    expect(hit?.t).toBeCloseTo(0.5, 5);
  });

  it('hits a fruit that sits between the two end points of a fast swipe', () => {
    // Neither end is near the fruit: only testing the whole segment finds it.
    expect(findSlice([fruit()], { ax: 100, ay: 300, bx: 900, by: 310 }, height)).not.toBeNull();
  });

  it('misses a fruit the segment passes by', () => {
    expect(findSlice([fruit()], { ax: 400, ay: 100, bx: 600, by: 100 }, height)).toBeNull();
    expect(findSlice([fruit()], { ax: 100, ay: 300, bx: 300, by: 300 }, height)).toBeNull();
  });

  it('is generous by a few percent around the fruit', () => {
    // 50 * 1.08 = 54 px from the centre still counts.
    expect(findSlice([fruit()], { ax: 400, ay: 353, bx: 600, by: 353 }, height)).not.toBeNull();
    expect(findSlice([fruit()], { ax: 400, ay: 356, bx: 600, by: 356 }, height)).toBeNull();
  });

  it('ignores fruits that are still waiting, already cut or off the stage', () => {
    const segment = { ax: 400, ay: 300, bx: 600, by: 300 };
    expect(findSlice([fruit({ wait: 0.2 })], segment, height)).toBeNull();
    expect(findSlice([fruit({ cut: true })], segment, height)).toBeNull();
    const below = { ax: 400, ay: 700, bx: 600, by: 700 };
    expect(findSlice([fruit({ y: 700 })], below, height)).toBeNull();
  });

  it('cuts only the first fruit along the swipe', () => {
    const near = fruit({ slot: 1, x: 400 });
    const far = fruit({ slot: 2, x: 700 });
    const hit = findSlice([far, near], { ax: 300, ay: 300, bx: 800, by: 300 }, height);
    expect(hit?.fruit.slot).toBe(1);
  });
});

describe('FruitField', () => {
  function field(): FruitField {
    const f = new FruitField(seeded(21));
    f.resize(STAGE.width, STAGE.height, STAGE.playTop);
    return f;
  }

  it('is not ready before it has a size', () => {
    expect(new FruitField().ready).toBeFalse();
    expect(field().ready).toBeTrue();
  });

  it('throws a wave when at most one fruit is left, and only while spawning is allowed', () => {
    const f = field();
    f.step(0.016, false);
    expect(f.fruits.length).toBe(0);
    f.step(0.016, true);
    expect(f.fruits.length).toBe(3);
    f.step(0.016, true);
    expect(f.fruits.length).toBe(3);
  });

  it('cuts a fruit into two halves with a flash and juice, and remembers where', () => {
    const f = field();
    const target = fruit({ slot: 1, x: 500, y: 300 });
    f.fruits.push(target);
    const cut = f.slash({ ax: 400, ay: 300, bx: 600, by: 300 });
    expect(cut).toBe(target);
    expect(target.cut).toBeTrue();
    expect(f.fruits.length).toBe(0);
    expect(f.halves.length).toBe(2);
    expect(f.halves.map(h => h.side).sort()).toEqual([-1, 1]);
    expect(f.flashes.length).toBe(1);
    expect(f.particles.length).toBe(26);
    expect(f.lastCut).toEqual({ x: 500, y: 300, slot: 1 });
  });

  it('leaves everything alone when the swipe misses', () => {
    const f = field();
    f.fruits.push(fruit());
    expect(f.slash({ ax: 0, ay: 0, bx: 100, by: 0 })).toBeNull();
    expect(f.fruits.length).toBe(1);
    expect(f.halves.length).toBe(0);
  });

  it('sprays fewer particles with reduced effects', () => {
    const f = field();
    f.effects = 0.4;
    f.fruits.push(fruit());
    f.slash({ ax: 400, ay: 300, bx: 600, by: 300 });
    expect(f.particles.length).toBe(10);
  });

  it('cuts the visible fruit of a slot for the keyboard, and nothing when there is none', () => {
    const f = field();
    f.fruits.push(fruit({ slot: 2 }), fruit({ slot: 0, wait: 0.3 }));
    expect(f.sliceSlot(0)).toBeNull();
    expect(f.sliceSlot(1)).toBeNull();
    expect(f.sliceSlot(2)?.slot).toBe(2);
    expect(f.halves.length).toBe(2);
  });

  it('keeps the halves and juice when the next question clears the fruits', () => {
    const f = field();
    f.fruits.push(fruit(), fruit({ slot: 1, x: 200 }));
    f.slash({ ax: 400, ay: 300, bx: 600, by: 300 });
    f.clearFruits();
    expect(f.fruits.length).toBe(0);
    expect(f.lastCut).toBeNull();
    expect(f.halves.length).toBe(2);
    expect(f.particles.length).toBeGreaterThan(0);
  });

  it('lets the pieces and the juice fall out and fade away', () => {
    const f = field();
    f.fruits.push(fruit());
    f.slash({ ax: 400, ay: 300, bx: 600, by: 300 });
    for (let i = 0; i < 400; i++) {
      f.step(0.016, false);
    }
    expect(f.halves.length).toBe(0);
    expect(f.particles.length).toBe(0);
    expect(f.flashes.length).toBe(0);
  });

  it('bursts sparkles at the last cut, or mid-stage when nothing was cut', () => {
    const f = field();
    f.sparkle();
    expect(f.particles.length).toBe(16);
    expect(f.particles.every(p => p.type === 'star' && p.x === 500)).toBeTrue();
    f.clear();
    f.fruits.push(fruit({ x: 200, y: 350 }));
    f.slash({ ax: 100, ay: 350, bx: 300, by: 350 });
    f.particles.length = 0;
    f.sparkle();
    expect(f.particles.every(p => p.x === 200 && p.y === 350)).toBeTrue();
  });

  it('starts over when the stage changes size but not when only the top row moves', () => {
    const f = field();
    f.fruits.push(fruit());
    f.resize(STAGE.width, STAGE.height, 140);
    expect(f.fruits.length).toBe(1);
    f.resize(800, 500, 140);
    expect(f.fruits.length).toBe(0);
  });
});

describe('HandCursor', () => {
  const W = 1000;
  const H = 600;
  // The long side is 1000 and the short side 600, so a swipe needs 0.45 * 600 = 270 px/s.
  const minSpeed = HAND_MIN_SPEED * Math.min(W, H);
  const jump = HAND_JUMP * Math.max(W, H);

  function placed(): HandCursor {
    const cursor = new HandCursor();
    cursor.point(500, 300, 0, W, H);
    return cursor;
  }

  it('starts a fresh trail where the hand first appears and never swipes from nowhere', () => {
    const cursor = new HandCursor();
    expect(cursor.point(500, 300, 0, W, H)).toEqual({ trail: 'restart', slash: null });
    expect(cursor.has).toBeTrue();
    expect(cursor.x).toBe(500);
    expect(cursor.y).toBe(300);
  });

  it('turns a fast move into a swipe from the old cursor position to the new one', () => {
    const cursor = placed();
    const step = cursor.point(560, 300, 33, W, H);
    expect(step.trail).toBe('extend');
    expect(step.slash).not.toBeNull();
    expect(step.slash?.ax).toBe(500);
    expect(step.slash?.ay).toBe(300);
    expect(step.slash?.bx).toBe(cursor.x);
    expect(step.slash?.by).toBe(cursor.y);
    // Eased toward the reading, not jumped onto it.
    expect(cursor.x).toBeGreaterThan(500);
    expect(cursor.x).toBeLessThan(560);
  });

  it('does not swipe on a slow move, it only steers the cursor', () => {
    const cursor = placed();
    // 4 px in 33 ms is about 50 px/s, far below the minimum.
    const step = cursor.point(504, 300, 33, W, H);
    expect(step.trail).toBe('extend');
    expect(step.slash).toBeNull();
    expect(Math.hypot(cursor.x - 500, 0) / 0.033).toBeLessThan(minSpeed);
    expect(cursor.x).toBeGreaterThan(500);
  });

  it('measures speed against the time since the last real move', () => {
    const cursor = placed();
    // Resting for a second must not make a later quick flick look slow, nor an old pause look fast.
    cursor.point(500.5, 300, 500, W, H);
    cursor.point(500.2, 300, 1000, W, H);
    expect(cursor.point(560, 300, 1033, W, H).slash).not.toBeNull();
  });

  it('ignores tiny jitter entirely', () => {
    const cursor = placed();
    expect(cursor.point(501, 300, 33, W, H)).toEqual({ trail: null, slash: null });
    expect(cursor.x).toBe(500);
  });

  it('ignores a jump larger than the limit once', () => {
    const cursor = placed();
    const step = cursor.point(500 + jump + 50, 300, 33, W, H);
    expect(step).toEqual({ trail: null, slash: null });
    expect(cursor.x).toBe(500);
    expect(cursor.y).toBe(300);
  });

  it('believes a jump when the next reading agrees, without a swipe or a trail line', () => {
    const cursor = placed();
    cursor.point(500 + jump + 50, 300, 33, W, H);
    const step = cursor.point(500 + jump + 60, 305, 66, W, H);
    expect(step).toEqual({ trail: 'restart', slash: null });
    expect(cursor.x).toBe(500 + jump + 60);
    expect(cursor.y).toBe(305);
  });

  it('keeps ignoring jumps that disagree with each other', () => {
    const cursor = placed();
    cursor.point(960, 580, 33, W, H);
    // A second far reading that is nowhere near the first outlier is another glitch.
    const step = cursor.point(40, 20, 66, W, H);
    expect(step).toEqual({ trail: null, slash: null });
    expect(cursor.x).toBe(500);
  });

  it('forgets a pending outlier once a normal reading arrives', () => {
    const cursor = placed();
    cursor.point(960, 580, 33, W, H);
    cursor.point(520, 300, 66, W, H);
    // The old outlier no longer vouches for a second far reading near it.
    expect(cursor.point(965, 580, 99, W, H)).toEqual({ trail: null, slash: null });
    expect(cursor.x).toBeLessThan(600);
  });

  it('drops the cursor only after the hand has been missing for a while', () => {
    const cursor = placed();
    expect(cursor.lost(100)).toBeFalse();
    expect(cursor.has).toBeTrue();
    expect(cursor.lost(200)).toBeTrue();
    expect(cursor.has).toBeFalse();
    expect(cursor.lost(300)).toBeFalse();
  });

  it('starts a new trail when the hand comes back after being lost', () => {
    const cursor = placed();
    cursor.lost(500);
    expect(cursor.point(100, 100, 600, W, H)).toEqual({ trail: 'restart', slash: null });
    expect(cursor.x).toBe(100);
  });
});
