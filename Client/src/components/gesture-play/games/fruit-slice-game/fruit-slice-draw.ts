import { clamp } from '../../../../game/gestures';
import { Flash, Fruit, FruitField, Half, Particle, SLOTS, TAU } from './fruit-slice-physics';

// Canvas drawing for the fruit-slicing game: the three fruit sprites (ported from the prototype's
// `FRUIT_DRAW`, a whole fruit and a cross-section each), the scene and the swipe trails. The fruits
// still carry no text on purpose; the answer boxes show each fruit's icon besides its colour, so the
// match also works by shape.

type Ctx = CanvasRenderingContext2D;

export interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

export interface FruitSprite {
  whole: HTMLCanvasElement;
  section: HTMLCanvasElement;
}

// The sprites are drawn in a -110..110 space where a fruit has a radius of about 100.
const SPRITE_SIZE = 340;
const SPRITE_SPACE = 220;

function applePath(x: Ctx): void {
  x.beginPath();
  x.moveTo(0, -64);
  x.bezierCurveTo(-22, -92, -92, -84, -92, -8);
  x.bezierCurveTo(-92, 52, -50, 98, -14, 92);
  x.bezierCurveTo(-6, 90, 6, 90, 14, 92);
  x.bezierCurveTo(50, 98, 92, 52, 92, -8);
  x.bezierCurveTo(92, -84, 22, -92, 0, -64);
  x.closePath();
}

function lemonPath(x: Ctx): void {
  x.beginPath();
  x.moveTo(-102, 0);
  x.bezierCurveTo(-96, -30, -62, -70, 0, -70);
  x.bezierCurveTo(62, -70, 96, -30, 102, 0);
  x.bezierCurveTo(96, 30, 62, 70, 0, 70);
  x.bezierCurveTo(-62, 70, -96, 30, -102, 0);
  x.closePath();
}

function ellipse(
  x: Ctx,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation: number,
  fill: string | CanvasGradient,
): void {
  x.fillStyle = fill;
  x.beginPath();
  x.ellipse(cx, cy, rx, ry, rotation, 0, TAU);
  x.fill();
}

function radial(x: Ctx, inner: number, outer: number, stops: [number, string][]): CanvasGradient {
  const gradient = x.createRadialGradient(0, 0, inner, 0, 0, outer);
  for (const [offset, colour] of stops) {
    gradient.addColorStop(offset, colour);
  }
  return gradient;
}

interface FruitDrawing {
  whole(x: Ctx): void;

  section(x: Ctx): void;
}

const FRUIT_DRAW: FruitDrawing[] = [
  {
    // Watermelon: striped green rind, red flesh with seeds on the cut face.
    whole(x) {
      const skin = x.createRadialGradient(-30, -35, 10, 0, 0, 100);
      skin.addColorStop(0, '#92ee80');
      skin.addColorStop(0.45, '#35b04f');
      skin.addColorStop(1, '#126a2c');
      x.fillStyle = skin;
      x.beginPath();
      x.arc(0, 0, 96, 0, TAU);
      x.fill();
      x.save();
      x.beginPath();
      x.arc(0, 0, 96, 0, TAU);
      x.clip();
      x.strokeStyle = 'rgba(8,72,30,.55)';
      x.lineCap = 'round';
      for (let k = -5; k <= 5; k++) {
        const a = k * 20;
        x.lineWidth = 8 + (k % 2 ? 2 : 0);
        x.beginPath();
        x.moveTo(a * 0.35, -100);
        x.bezierCurveTo(a * 1.35, -45, a * 1.35, 45, a * 0.35, 100);
        x.stroke();
      }
      x.restore();
      x.lineWidth = 3;
      x.strokeStyle = '#0c4a20';
      x.beginPath();
      x.arc(0, 0, 96, 0, TAU);
      x.stroke();
      ellipse(x, -36, -46, 20, 34, -0.6, 'rgba(255,255,255,.34)');
      x.fillStyle = '#6b4a1e';
      x.beginPath();
      x.moveTo(-5, -92);
      x.lineTo(5, -92);
      x.lineTo(4, -108);
      x.lineTo(-4, -108);
      x.closePath();
      x.fill();
    },
    section(x) {
      ellipse(x, 0, 0, 96, 96, 0, '#1b7a35');
      ellipse(x, 0, 0, 89, 89, 0, '#b9e48a');
      ellipse(x, 0, 0, 84, 84, 0, '#f2f8d9');
      const flesh = x.createRadialGradient(0, -10, 6, 0, 0, 80);
      flesh.addColorStop(0, '#ff8a93');
      flesh.addColorStop(0.6, '#ff3b55');
      flesh.addColorStop(1, '#d81f3c');
      ellipse(x, 0, 0, 78, 78, 0, flesh);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU + 0.3;
        const radius = i % 2 ? 34 : 56;
        ellipse(x, Math.cos(a) * radius, Math.sin(a) * radius, 4.5, 8, a + Math.PI / 2, '#1a1a1a');
      }
      ellipse(x, -22, -30, 16, 10, -0.6, 'rgba(255,255,255,.22)');
    },
  },
  {
    // Apple: red skin with a stem and a leaf, pale flesh and two seeds on the cut face.
    whole(x) {
      const skin = x.createRadialGradient(-32, -30, 6, 0, 10, 100);
      skin.addColorStop(0, '#ff8f86');
      skin.addColorStop(0.42, '#e53935');
      skin.addColorStop(0.85, '#a31515');
      skin.addColorStop(1, '#7a0c10');
      applePath(x);
      x.fillStyle = skin;
      x.fill();
      x.lineWidth = 2.5;
      x.strokeStyle = '#6e0b0f';
      x.stroke();
      ellipse(x, 0, -64, 16, 7, 0, 'rgba(90,0,0,.28)');
      ellipse(x, -44, -32, 14, 26, -0.5, 'rgba(255,255,255,.42)');
      x.strokeStyle = '#6b4423';
      x.lineWidth = 7;
      x.lineCap = 'round';
      x.beginPath();
      x.moveTo(0, -62);
      x.quadraticCurveTo(2, -86, 12, -102);
      x.stroke();
      x.fillStyle = '#4caf50';
      x.beginPath();
      x.moveTo(8, -86);
      x.bezierCurveTo(24, -112, 54, -106, 62, -94);
      x.bezierCurveTo(46, -78, 22, -76, 8, -86);
      x.fill();
      x.strokeStyle = 'rgba(20,80,25,.7)';
      x.lineWidth = 2;
      x.beginPath();
      x.moveTo(12, -86);
      x.quadraticCurveTo(34, -92, 56, -95);
      x.stroke();
    },
    section(x) {
      applePath(x);
      x.fillStyle = '#c62828';
      x.fill();
      x.save();
      x.scale(0.9, 0.9);
      applePath(x);
      x.fillStyle = radial(x, 6, 92, [
        [0, '#fffdf0'],
        [1, '#ffe9a8'],
      ]);
      x.fill();
      x.restore();
      ellipse(x, 0, 6, 20, 36, 0, 'rgba(214,176,104,.55)');
      x.lineWidth = 2;
      x.strokeStyle = 'rgba(150,100,40,.5)';
      x.beginPath();
      x.ellipse(0, 6, 20, 36, 0, 0, TAU);
      x.stroke();
      ellipse(x, -7, 8, 4.5, 9, 0.25, '#5a3416');
      ellipse(x, 7, 8, 4.5, 9, -0.25, '#5a3416');
      ellipse(x, -34, -30, 18, 10, -0.6, 'rgba(255,255,255,.35)');
    },
  },
  {
    // Lemon: pointed ends and a dotted peel, segments radiating from the centre on the cut face.
    whole(x) {
      const skin = x.createRadialGradient(-25, -28, 5, 0, 0, 105);
      skin.addColorStop(0, '#fffbb4');
      skin.addColorStop(0.4, '#ffe135');
      skin.addColorStop(0.8, '#f2c200');
      skin.addColorStop(1, '#c99400');
      lemonPath(x);
      x.fillStyle = skin;
      x.fill();
      ellipse(x, -101, 0, 7, 9, 0, '#d9a800');
      ellipse(x, 101, 0, 7, 9, 0, '#d9a800');
      lemonPath(x);
      x.lineWidth = 2.5;
      x.strokeStyle = 'rgba(150,100,0,.65)';
      x.stroke();
      // The peel's pores come from a tiny seeded generator, so every game draws the same lemon.
      let seed = 7;
      x.fillStyle = 'rgba(160,110,0,.2)';
      for (let i = 0; i < 34; i++) {
        seed = (seed * 9301 + 49297) % 233280;
        const px = (seed / 233280 - 0.5) * 170;
        seed = (seed * 9301 + 49297) % 233280;
        const py = (seed / 233280 - 0.5) * 100;
        x.beginPath();
        x.arc(px, py, 1.7, 0, TAU);
        x.fill();
      }
      ellipse(x, -34, -30, 26, 10, -0.35, 'rgba(255,255,255,.55)');
    },
    section(x) {
      lemonPath(x);
      x.fillStyle = '#f4d03f';
      x.fill();
      x.save();
      x.scale(0.93, 0.93);
      lemonPath(x);
      x.fillStyle = '#fffbe0';
      x.fill();
      x.restore();
      x.save();
      x.scale(0.86, 0.86);
      lemonPath(x);
      x.fillStyle = radial(x, 4, 100, [
        [0, '#fff6a0'],
        [1, '#ffe04a'],
      ]);
      x.fill();
      x.clip();
      x.strokeStyle = 'rgba(255,255,255,.8)';
      x.lineWidth = 3.5;
      x.lineCap = 'round';
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU;
        x.beginPath();
        x.moveTo(0, 0);
        x.lineTo(Math.cos(a) * 115, Math.sin(a) * 85);
        x.stroke();
      }
      x.restore();
      ellipse(x, 0, 0, 6, 6, 0, '#fffbe0');
    },
  },
];

function makeSprite(draw: (x: Ctx) => void): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SPRITE_SIZE;
  const x = canvas.getContext('2d');
  if (x) {
    x.translate(SPRITE_SIZE / 2, SPRITE_SIZE / 2);
    x.scale(SPRITE_SIZE / SPRITE_SPACE, SPRITE_SIZE / SPRITE_SPACE);
    draw(x);
  }
  return canvas;
}

let sprites: FruitSprite[] | null = null;

// Built on first use and then shared by every game instance: drawing six 340 px sprites is cheap
// but there is no reason to repeat it for each stage the player starts.
export function fruitSprites(): FruitSprite[] {
  sprites ??= FRUIT_DRAW.map(d => ({
    whole: makeSprite(d.whole),
    section: makeSprite(d.section)
  }));
  return sprites;
}

function drawFruit(ctx: Ctx, fruit: Fruit, sprite: FruitSprite): void {
  const r = fruit.r;
  const glow = SLOTS[fruit.slot].glow;
  ctx.save();
  ctx.translate(fruit.x, fruit.y);
  const halo = ctx.createRadialGradient(0, 0, r * 0.6, 0, 0, r * 1.65);
  halo.addColorStop(0, `rgba(${glow},.28)`);
  halo.addColorStop(1, `rgba(${glow},0)`);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.65, 0, TAU);
  ctx.fill();
  ctx.shadowColor = 'rgba(0,0,0,.3)';
  ctx.shadowBlur = r * 0.4;
  ctx.shadowOffsetY = r * 0.14;
  ctx.rotate(fruit.rot);
  ctx.drawImage(sprite.whole, -1.1 * r, -1.1 * r, 2.2 * r, 2.2 * r);
  ctx.restore();
}

// One half of a cut fruit: the cross-section sprite clipped to the half-plane on its side of the
// cut, so the two halves together show the whole cut face.
function drawHalf(ctx: Ctx, half: Half, sprite: FruitSprite): void {
  const r = half.r;
  ctx.save();
  ctx.translate(half.x, half.y);
  ctx.rotate(half.rot);
  ctx.beginPath();
  if (half.side < 0) {
    ctx.rect(-r * 1.3, -r * 1.3, r * 1.3, r * 2.6);
  } else {
    ctx.rect(0, -r * 1.3, r * 1.3, r * 2.6);
  }
  ctx.clip();
  ctx.rotate(half.off);
  ctx.drawImage(sprite.section, -1.1 * r, -1.1 * r, 2.2 * r, 2.2 * r);
  ctx.restore();
}

// A white streak with a pink glow, so it still shows against the app's light background.
function drawFlash(ctx: Ctx, flash: Flash): void {
  const k = flash.life / flash.max;
  ctx.save();
  ctx.translate(flash.x, flash.y);
  ctx.rotate(flash.ang);
  ctx.shadowColor = 'rgba(255,142,203,.9)';
  ctx.shadowBlur = 14;
  const streak = ctx.createLinearGradient(-flash.len / 2, 0, flash.len / 2, 0);
  streak.addColorStop(0, 'rgba(255,255,255,0)');
  streak.addColorStop(0.5, `rgba(255,255,255,${k})`);
  streak.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = streak;
  ctx.fillRect(-flash.len / 2, -3 * k - 1, flash.len, 6 * k + 2);
  ctx.restore();
}

function drawStar(ctx: Ctx, p: Particle): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.life * 6);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const radius = i % 2 ? p.r * 0.35 : p.r;
    const a = (i / 8) * TAU;
    ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// The fruits, their halves, the cut flashes and the juice, back to front.
export function drawField(ctx: Ctx, field: FruitField): void {
  const all = fruitSprites();
  for (const half of field.halves) {
    drawHalf(ctx, half, all[half.slot]);
  }
  for (const fruit of field.fruits) {
    if (fruit.wait <= 0) {
      drawFruit(ctx, fruit, all[fruit.slot]);
    }
  }
  for (const flash of field.flashes) {
    drawFlash(ctx, flash);
  }
  for (const p of field.particles) {
    ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
    ctx.fillStyle = p.col;
    if (p.type === 'star') {
      drawStar(ctx, p);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

const TRAIL_LIFE_MS = 280;

// A glowing swipe trail that fades from its tail: a coloured stroke under a thin white core. Points
// older than the trail's lifetime are dropped from the array as it is drawn. Normal blending is
// used rather than the prototype's additive one, which would vanish against the app's light
// background.
export function drawTrail(
  ctx: Ctx,
  trail: TrailPoint[],
  now: number,
  rgb: string,
  stageSize: number,
): void {
  while (trail.length && now - trail[0].t > TRAIL_LIFE_MS) {
    trail.shift();
  }
  if (trail.length < 2) {
    return;
  }
  const scale = clamp(stageSize / 600, 0.7, 1.5);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1];
    const b = trail[i];
    const k = 1 - (now - b.t) / TRAIL_LIFE_MS;
    if (k <= 0) {
      continue;
    }
    ctx.shadowColor = `rgba(${rgb},.95)`;
    ctx.shadowBlur = 16;
    ctx.strokeStyle = `rgba(${rgb},${0.85 * k})`;
    ctx.lineWidth = Math.max(2, 17 * k * scale);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(255,255,255,${0.95 * k})`;
    ctx.lineWidth = Math.max(1.2, 6 * k * scale);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

// The fingertip cursor: a soft yellow glow around a white ring. The ring carries a faint dark
// shadow so it stays visible over the white parts of the camera image as well as the dark ones.
export function drawCursor(ctx: Ctx, x: number, y: number, stageSize: number): void {
  const r = clamp(stageSize * 0.022, 9, 18);
  ctx.save();
  const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 2.6);
  glow.addColorStop(0, 'rgba(255,255,255,.95)');
  glow.addColorStop(0.35, 'rgba(255,214,38,.75)');
  glow.addColorStop(1, 'rgba(255,214,38,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, r * 2.6, 0, TAU);
  ctx.fill();
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = 5;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
  ctx.restore();
}
