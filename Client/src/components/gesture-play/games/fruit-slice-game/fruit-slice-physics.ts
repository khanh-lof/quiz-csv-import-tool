import { clamp, segHit } from '../../../../game/gestures';

// The pure half of the fruit-slicing game, ported from the "Chém hoa quả" prototype: how fruits are
// thrown, how a swipe cuts them, how the cut pieces and juice fly, and how the fingertip reading is
// cleaned up before it may cut anything. Nothing here touches the DOM or a canvas, so every rule is
// unit-testable with a seeded random source.

export const TAU = Math.PI * 2;

// A fingertip reading that jumps farther than this share of the stage's longer side in one step is
// treated as a tracking glitch and ignored once.
export const HAND_JUMP = 0.42;
// A move has to be at least this fast (shorter side of the stage per second) to count as a swipe;
// slower hand movement only steers the cursor, so resting a finger on a fruit never cuts it.
export const HAND_MIN_SPEED = 0.45;
// A hand missing from the frames for longer than this is gone (shorter gaps are tracking flicker).
export const HAND_LOST_MS = 150;

export type Rng = () => number;

export function rand(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Colour, fruit and answer box are tied together by the slot: slot 0 (the first option, a green
// box) is the watermelon, slot 1 (red) the apple and slot 2 (yellow) the lemon. `glow` is the halo
// behind a flying fruit as an "r,g,b" triple and `juice` the colours of the droplets a cut sprays.
export interface FruitSlot {
  name: string;
  glow: string;
  juice: string[];
}

export const SLOTS: readonly FruitSlot[] = [
  { name: 'xanh lá', glow: '53,199,89', juice: ['#6fdc4f', '#b6f27a', '#ff7b8a'] },
  { name: 'đỏ', glow: '255,77,79', juice: ['#ff6b6b', '#ff9a9a', '#ffd27a'] },
  { name: 'vàng', glow: '255,212,38', juice: ['#ffd426', '#ffe66d', '#ffb300'] },
];

export interface Fruit {
  slot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  // Gravity of this throw, in px/s². Every fruit gets its own so that all of them peak inside the
  // play area at their own height.
  g: number;
  r: number;
  rot: number;
  vr: number;
  // Seconds until the fruit leaves the bottom edge; waves are staggered so the three do not rise as
  // one block. A waiting fruit is neither drawn nor cuttable.
  wait: number;
  cut: boolean;
}

// One side of a cut fruit, drawn from the fruit's cross-section sprite.
export interface Half {
  slot: number;
  side: -1 | 1;
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  r: number;
  rot: number;
  off: number;
  vr: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  r: number;
  life: number;
  max: number;
  col: string;
  type: 'drop' | 'star';
}

// The bright streak left across a fruit at the moment it is cut.
export interface Flash {
  x: number;
  y: number;
  ang: number;
  life: number;
  max: number;
  len: number;
}

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface StageMetrics {
  width: number;
  height: number;
  // The y below which fruits fly; the question and answer boxes sit above it.
  playTop: number;
  // The fruit radius before the per-fruit variation.
  radius: number;
}

export function fruitRadius(width: number, height: number): number {
  return clamp(Math.min(width, height) * 0.115, 32, 86);
}

// Throws one fruit per slot, each from below the stage up to its own apex inside the play area. A
// fruit starts at y0 under the bottom edge and rises for T seconds to apexY: with the gravity and
// the launch speed derived from that distance, y(T) is exactly the apex, so the peak is known up
// front and a fruit can never fly out of the top of the stage. The three fruits go to three
// different thirds of the width in a random order, and the horizontal speed is limited so the
// sideways drift never carries a fruit past the stage edge.
export function spawnWave(
  metrics: StageMetrics,
  slotCount = SLOTS.length,
  rng: Rng = Math.random,
): Fruit[] {
  const { width: w, height: h, playTop, radius } = metrics;
  const slots = shuffle(
    Array.from({ length: Math.min(slotCount, SLOTS.length) }, (_, i) => i),
    rng,
  );
  const columns = shuffle([0, 1, 2], rng);
  return slots.map((slot, i) => {
    const r = radius * rand(rng, 0.95, 1.08);
    const flight = rand(rng, 1.15, 1.45);
    const apexMin = playTop + r * 1.15;
    const apexMax = Math.max(apexMin + 10, playTop + (h - playTop) * 0.42);
    const apexY = rand(rng, apexMin, apexMax);
    const y0 = h + r * 1.3;
    const g = (2 * (y0 - apexY)) / (flight * flight);
    const vy = -g * flight;
    const vx = rand(rng, -1, 1) * w * 0.07;
    const drift = Math.abs(vx) * flight;
    const lo = r + drift + 4;
    const hi = w - r - drift - 4;
    const column = ((columns[slot] + 0.5) / 3) * w + rand(rng, -0.06, 0.06) * w;
    const apexX = lo > hi ? w / 2 : clamp(column, lo, hi);
    return {
      slot,
      x: apexX - vx * flight,
      y: y0,
      vx,
      vy,
      g,
      r,
      rot: rand(rng, 0, TAU),
      vr: rand(rng, -3, 3),
      wait: i * 0.22 + rand(rng, 0, 0.1),
      cut: false,
    };
  });
}

// Where a fruit's highest point is: the apex of the parabola it was thrown on.
export function apexOf(fruit: Fruit): { x: number; y: number } {
  const rise = (fruit.vy * fruit.vy) / (2 * fruit.g);
  const time = -fruit.vy / fruit.g;
  return { x: fruit.x + fruit.vx * time, y: fruit.y - rise };
}

export interface SliceHit {
  fruit: Fruit;
  t: number;
  d: number;
}

// The fruit a swipe segment cuts first. The whole segment is tested, not just its end point, so a
// fast swipe that skips over a fruit between two frames still hits it; of several fruits on the
// path the one met first (smallest t, then the closest pass) wins, so one swipe cuts one fruit.
export function findSlice(
  fruits: readonly Fruit[],
  { ax, ay, bx, by }: Segment,
  stageHeight: number,
): SliceHit | null {
  let best: SliceHit | null = null;
  for (const fruit of fruits) {
    if (fruit.wait > 0 || fruit.cut || fruit.y < -fruit.r || fruit.y > stageHeight + fruit.r) {
      continue;
    }
    const hit = segHit(ax, ay, bx, by, fruit.x, fruit.y, fruit.r * 1.08);
    if (
      hit &&
      (!best || hit.t < best.t - 1e-6 || (Math.abs(hit.t - best.t) < 1e-6 && hit.d < best.d))
    ) {
      best = { fruit, t: hit.t, d: hit.d };
    }
  }
  return best;
}

// How many cut-fruit droplets and sparkles a slice makes at full effect; `effects` scales them down
// for players who asked for less motion.
const DROPLETS = 26;
const SPARKLES = 16;

// Everything that moves on the stage: the fruits in the air, the halves and droplets of the ones
// already cut, and the streaks and sparkles of a hit. The component feeds it swipes and calls
// `step` once per frame.
export class FruitField {
  fruits: Fruit[] = [];
  halves: Half[] = [];
  particles: Particle[] = [];
  flashes: Flash[] = [];
  metrics: StageMetrics = { width: 0, height: 0, playTop: 0, radius: 32 };
  // How many answers (and so colours of fruit) the current question has.
  slotCount = SLOTS.length;
  // 1 for normal play, less for `prefers-reduced-motion`.
  effects = 1;
  // Where the last fruit was cut, so the sparkles of a correct answer burst there.
  lastCut: { x: number; y: number; slot: number } | null = null;

  private waveDelay = 0;

  constructor(private readonly rng: Rng = Math.random) {}

  get ready(): boolean {
    return this.metrics.width > 0 && this.metrics.height > 0;
  }

  // A new stage size invalidates everything in flight (positions are in pixels), so it starts the
  // scene over; a mere shift of the top row only moves the line fruits may not cross.
  resize(width: number, height: number, playTop: number): void {
    const changed = width !== this.metrics.width || height !== this.metrics.height;
    this.metrics = { width, height, playTop, radius: fruitRadius(width, height) };
    if (changed) {
      this.clear();
    }
  }

  // The next question: fruits of the old one are removed, but halves and droplets are left to fall
  // and fade out so the cut is not wiped from under the player's eyes.
  clearFruits(): void {
    this.fruits.length = 0;
    this.waveDelay = 0;
    this.lastCut = null;
  }

  clear(): void {
    this.clearFruits();
    this.halves.length = 0;
    this.particles.length = 0;
    this.flashes.length = 0;
  }

  // Advances everything by `dt` seconds. A new wave goes up whenever at most one fruit is left in
  // the air and `spawning` allows it. The physics step is capped so a stalled frame (a background
  // tab) does not fling everything off the stage at once.
  step(dt: number, spawning: boolean): void {
    const pdt = Math.min(dt, 0.1);
    const { height } = this.metrics;
    if (spawning && this.fruits.length <= 1) {
      this.waveDelay -= dt;
      if (this.waveDelay <= 0) {
        this.fruits.push(...spawnWave(this.metrics, this.slotCount, this.rng));
        this.waveDelay = 0.15;
      }
    }
    for (let i = this.fruits.length - 1; i >= 0; i--) {
      const f = this.fruits[i];
      if (f.wait > 0) {
        f.wait -= pdt;
        continue;
      }
      f.vy += f.g * pdt;
      f.x += f.vx * pdt;
      f.y += f.vy * pdt;
      f.rot += f.vr * pdt;
      if (f.vy > 0 && f.y > height + f.r * 1.4) {
        this.fruits.splice(i, 1);
      }
    }
    for (let i = this.halves.length - 1; i >= 0; i--) {
      const h = this.halves[i];
      h.vy += h.g * pdt;
      h.x += h.vx * pdt;
      h.y += h.vy * pdt;
      h.rot += h.vr * pdt;
      if (h.y > height + h.r * 1.6) {
        this.halves.splice(i, 1);
      }
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= pdt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += p.g * pdt;
      p.x += p.vx * pdt;
      p.y += p.vy * pdt;
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      this.flashes[i].life -= pdt;
      if (this.flashes[i].life <= 0) {
        this.flashes.splice(i, 1);
      }
    }
  }

  // Cuts the first fruit the swipe segment crosses, if any, and returns it.
  slash(segment: Segment): Fruit | null {
    const hit = findSlice(this.fruits, segment, this.metrics.height);
    if (!hit) {
      return null;
    }
    this.cut(hit.fruit, Math.atan2(segment.by - segment.ay, segment.bx - segment.ax));
    return hit.fruit;
  }

  // The keyboard way: cuts the visible fruit of a slot along a random upward diagonal.
  sliceSlot(slot: number): Fruit | null {
    const { height } = this.metrics;
    const fruit = this.fruits.find(
      f => f.slot === slot && f.wait <= 0 && !f.cut && f.y > 0 && f.y < height,
    );
    if (!fruit) {
      return null;
    }
    this.cut(fruit, rand(this.rng, -1.1, -0.3));
    return fruit;
  }

  // Splits a fruit along a cut at angle `ang` into two halves that fly apart, with a flash and a
  // spray of juice in the fruit's colours.
  cut(fruit: Fruit, ang: number): void {
    const index = this.fruits.indexOf(fruit);
    if (index >= 0) {
      this.fruits.splice(index, 1);
    }
    fruit.cut = true;
    this.lastCut = { x: fruit.x, y: fruit.y, slot: fruit.slot };
    const rng = this.rng;
    const base = ang - Math.PI / 2;
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    const push = fruit.r * rand(rng, 1.7, 2.5);
    for (const side of [-1, 1] as const) {
      this.halves.push({
        slot: fruit.slot,
        side,
        x: fruit.x,
        y: fruit.y,
        vx: fruit.vx * 0.5 + nx * -side * push,
        vy: fruit.vy * 0.4 + ny * -side * push - fruit.r * 0.6,
        g: fruit.g * 0.9,
        r: fruit.r,
        rot: base,
        off: fruit.rot - base,
        vr: side * rand(rng, 1, 2.6) + fruit.vr * 0.3,
      });
    }
    this.flashes.push({ x: fruit.x, y: fruit.y, ang, life: 0.28, max: 0.28, len: fruit.r * 2.8 });
    const juice = SLOTS[fruit.slot].juice;
    const drops = Math.round(DROPLETS * this.effects);
    for (let k = 0; k < drops; k++) {
      const a = ang + (rng() < 0.5 ? Math.PI / 2 : -Math.PI / 2) + rand(rng, -0.9, 0.9);
      const speed = fruit.r * rand(rng, 1.5, 5.5);
      this.particles.push({
        x: fruit.x,
        y: fruit.y,
        vx: Math.cos(a) * speed + fruit.vx * 0.3,
        vy: Math.sin(a) * speed - fruit.r * rand(rng, 0, 1.5),
        g: fruit.r * 9,
        r: rand(rng, 2, 5.5),
        life: rand(rng, 0.5, 1),
        max: 1,
        col: juice[k % juice.length],
        type: 'drop',
      });
    }
  }

  // The burst of stars for a correct answer, at the last cut or, when nothing was cut (the answer
  // came from the keyboard with no fruit in view), in the middle of the play area.
  sparkle(): void {
    const { width, height, playTop, radius } = this.metrics;
    const at = this.lastCut ?? { x: width / 2, y: playTop + (height - playTop) * 0.4 };
    const rng = this.rng;
    const count = Math.round(SPARKLES * this.effects);
    for (let k = 0; k < count; k++) {
      const a = rand(rng, 0, TAU);
      const speed = radius * rand(rng, 2, 5);
      this.particles.push({
        x: at.x,
        y: at.y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - radius,
        g: radius * 4,
        r: rand(rng, 5, 11),
        life: rand(rng, 0.6, 1),
        max: 1,
        col: k % 2 ? '#ffd426' : '#ff8ecb',
        type: 'star',
      });
    }
  }
}

export interface HandStep {
  // What happened to the trail drawn behind the cursor: 'restart' begins a new one at the cursor
  // (the hand just appeared, or the cursor re-synced after a glitch), 'extend' adds the cursor's
  // new position, null leaves it alone.
  trail: 'restart' | 'extend' | null;
  // The stretch the fingertip travelled fast enough to count as a swipe, if it did.
  slash: Segment | null;
}

// Turns the raw fingertip positions (already mapped to stage pixels) into a steady cursor and the
// swipes it makes, as the prototype's `handPoint` does: an implausible jump is held back for one
// frame and only believed if the next reading agrees with it, tiny jitter is ignored, the cursor
// follows with an adaptive blend (stiff when slow, nearly direct when fast) and only a fast enough
// move produces a swipe segment.
export class HandCursor {
  has = false;
  x = 0;
  y = 0;

  private movedAt = 0;
  private seenAt = 0;
  private outlier = false;
  private outlierX = 0;
  private outlierY = 0;

  point(px: number, py: number, now: number, width: number, height: number): HandStep {
    const longSide = Math.max(width, height);
    this.seenAt = now;
    if (!this.has) {
      // The hand just came into view: start from where it is, never draw a line from the old spot.
      this.has = true;
      this.place(px, py, now);
      return { trail: 'restart', slash: null };
    }
    const d = Math.hypot(px - this.x, py - this.y);
    if (d > HAND_JUMP * longSide) {
      if (this.outlier && Math.hypot(px - this.outlierX, py - this.outlierY) < 0.12 * longSide) {
        // Two readings in a row agree on the new place, so the hand really went there.
        this.place(px, py, now);
        return { trail: 'restart', slash: null };
      }
      this.outlier = true;
      this.outlierX = px;
      this.outlierY = py;
      return { trail: null, slash: null };
    }
    this.outlier = false;
    if (d < Math.max(1.5, 0.002 * longSide)) {
      // Resting still: a steady hand's landmark wobbles by a pixel or two. Remembering the moment
      // keeps the time since the last real move short, so the next move's speed is not diluted.
      this.movedAt = now;
      return { trail: null, slash: null };
    }
    const blend = clamp(0.35 + d / (0.08 * longSide), 0.35, 0.85);
    const from = { x: this.x, y: this.y };
    this.x += (px - this.x) * blend;
    this.y += (py - this.y) * blend;
    const seconds = Math.max(1, now - this.movedAt) / 1000;
    this.movedAt = now;
    const fast =
      Math.hypot(this.x - from.x, this.y - from.y) / seconds >=
      HAND_MIN_SPEED * Math.min(width, height);
    return {
      trail: 'extend',
      slash: fast ? { ax: from.x, ay: from.y, bx: this.x, by: this.y } : null,
    };
  }

  // Call when a frame has no hand. Returns true on the call that drops the cursor, which is only
  // after the hand has been missing for `graceMs`, so a one-frame flicker does not cut the trail.
  lost(now: number, graceMs = HAND_LOST_MS): boolean {
    if (this.has && now - this.seenAt > graceMs) {
      this.reset();
      return true;
    }
    return false;
  }

  reset(): void {
    this.has = false;
    this.outlier = false;
  }

  private place(px: number, py: number, now: number): void {
    this.x = px;
    this.y = py;
    this.movedAt = now;
    this.outlier = false;
  }
}
