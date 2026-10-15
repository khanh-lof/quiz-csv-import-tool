// The rules of the sentence-ordering game, without Angular or the DOM so they can be tested with
// synthetic input: the answer line as a list of chunk positions, the hit test for the camera cursor,
// and the two ways of picking a target (dwell and pinch).

// How long the cursor has to rest on one target before it is picked, and how long (or until the cursor
// has left it) that same target is then not offered again, so a long hover does not pick twice.
export const DWELL_MS = 700;
export const COOLDOWN_MS = 400;
// The cursor can slip off a target for a frame or two (tracking noise at the edge); a break shorter
// than this does not reset the hover.
export const LEAVE_GRACE_MS = 100;
// A fully built sentence is shown this long before it is reported, so the player sees it whole and can
// still take a tile back.
export const COMPLETE_DELAY_MS = 400;
// Closing thumb and index nudges the fingertip. A pinch picks the target the cursor was resting on, not
// one it has only just slid onto: a target counts as "resting" after PINCH_SETTLE_MS, and the one the
// cursor left less than PINCH_MEMORY_MS ago is still remembered.
export const PINCH_SETTLE_MS = 100;
export const PINCH_MEMORY_MS = 250;
// A pause between two steps longer than this (paused game, hidden tab) clears the selector instead of
// counting as hover time.
export const MAX_STEP_GAP_MS = 1000;

// ---- Targets and the answer line -------------------------------------------------------------

// A target is anything the player can pick, named by a string so it can be compared and used as a DOM
// data attribute: a tile still in the pool ('pool:<chunk index>'), a tile placed on the answer line
// ('line:<position in the line>'), or the undo card.
export const UNDO_TARGET = 'undo';

export function poolTarget(index: number): string {
  return `pool:${index}`;
}

export function lineTarget(position: number): string {
  return `line:${position}`;
}

export type TargetAction =
  | { kind: 'place'; index: number }
  | { kind: 'remove'; position: number }
  | { kind: 'undo' };

export function parseTarget(id: string): TargetAction | null {
  if (id === UNDO_TARGET) {
    return { kind: 'undo' };
  }
  const match = /^(pool|line):(\d+)$/.exec(id);
  if (!match) {
    return null;
  }
  const number = Number(match[2]);
  return match[1] === 'pool'
    ? {
      kind: 'place',
      index: number
    }
    : {
      kind: 'remove',
      position: number
    };
}

// The answer line is the chunk indexes in the order the player placed them. Indexes, not texts: a
// sentence can hold the same chunk twice (two 的), and the two tiles must stay distinct. Every
// operation returns a new line, or null when it is not allowed, so a caller never needs to compare.

export function placeTile(line: readonly number[], index: number, size: number): number[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= size || line.includes(index)) {
    return null;
  }
  return [...line, index];
}

// Sends the tile at `position` (and only it) back to the pool; the tiles after it close the gap.
export function removeTileAt(line: readonly number[], position: number): number[] | null {
  if (!Number.isInteger(position) || position < 0 || position >= line.length) {
    return null;
  }
  return line.filter((_, at) => at !== position);
}

export function undoLast(line: readonly number[]): number[] | null {
  return line.length > 0 ? line.slice(0, -1) : null;
}

// Does the target exist right now? The camera cursor only hits valid targets, and a click on a stale
// one is ignored.
export function isValidTarget(line: readonly number[], id: string, size: number): boolean {
  const action = parseTarget(id);
  switch (action?.kind) {
    case 'place':
      return action.index < size && !line.includes(action.index);
    case 'remove':
      return action.position < line.length;
    case 'undo':
      return line.length > 0;
    default:
      return false;
  }
}

// The line after the player picks `id`, or null when that does nothing.
export function applyTarget(line: readonly number[], id: string, size: number): number[] | null {
  const action = parseTarget(id);
  switch (action?.kind) {
    case 'place':
      return placeTile(line, action.index, size);
    case 'remove':
      return removeTileAt(line, action.position);
    case 'undo':
      return undoLast(line);
    default:
      return null;
  }
}

export function isComplete(line: readonly number[], size: number): boolean {
  return size > 0 && line.length === size;
}

export function orderOf(line: readonly number[], chunks: readonly string[]): string[] {
  return line.map(index => chunks[index]);
}

// ---- Hit test ---------------------------------------------------------------------------------

export interface TargetRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function gapTo(rect: TargetRect, x: number, y: number): number {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

// The target under the point, with every rectangle grown by `pad` so a shaky fingertip near an edge
// still counts. Inside beats near, and between two overlapping grown areas the nearer centre wins, so
// the answer never depends on the order of `rects`.
export function hitTest(
  x: number,
  y: number,
  rects: readonly TargetRect[],
  pad: number,
): string | null {
  let best: string | null = null;
  let bestGap = Infinity;
  let bestCentre = Infinity;
  for (const rect of rects) {
    const gap = gapTo(rect, x, y);
    if (gap > pad) {
      continue;
    }
    const centre = Math.hypot(x - (rect.x + rect.width / 2), y - (rect.y + rect.height / 2));
    if (gap < bestGap || (gap === bestGap && centre < bestCentre)) {
      best = rect.id;
      bestGap = gap;
      bestCentre = centre;
    }
  }
  return best;
}

// ---- Picking: dwell and pinch -------------------------------------------------------------------

export interface SelectorOptions {
  dwellMs?: number;
  cooldownMs?: number;
  graceMs?: number;
  settleMs?: number;
  memoryMs?: number;
  maxGapMs?: number;
}

export interface SelectorInput {
  // The target under the cursor right now, null when none or no hand.
  hover: string | null;
  // True on the one step where the fingers close (PinchDetector's `changed === 'down'`).
  pinchDown?: boolean;
  // True while the fingers are closed.
  pinched?: boolean;
  now: number;
}

export interface SelectorStep {
  // The target under the cursor, for highlighting. It can be a target that is cooling down.
  hovered: string | null;
  // The target whose dwell ring is running, null when none.
  target: string | null;
  // 0..1 of the dwell time on `target`.
  progress: number;
  // A dwell on a new target began on this step.
  started: boolean;
  // The dwell reached its half on this step.
  halfway: boolean;
  // The target picked on this step, and how.
  picked: string | null;
  via: 'dwell' | 'pinch' | null;
}

// Separates pointing from committing: the cursor only points, and a target is picked either by resting
// on it for `dwellMs` (easiest for children) or by closing thumb and index while on it (faster). After
// a pick the same target is not offered for another dwell until the cursor has left it or `cooldownMs`
// has passed. The caller decides what a pick does and feeds only targets that exist.
export class TargetSelector {
  private readonly dwellMs: number;
  private readonly cooldownMs: number;
  private readonly graceMs: number;
  private readonly settleMs: number;
  private readonly memoryMs: number;
  private readonly maxGapMs: number;

  // The dwell in progress.
  private current: string | null = null;
  private since = 0;
  private awaySince: number | null = null;
  private halfDone = false;
  // The target that was just picked and may not start a dwell yet.
  private blocked: string | null = null;
  private blockedUntil = 0;
  private blockedAwaySince: number | null = null;
  // What the cursor has been over, for the pinch.
  private resting: string | null = null;
  private restingSince = 0;
  private left: { id: string; at: number } | null = null;
  private last: number | null = null;

  constructor({
                dwellMs = DWELL_MS,
                cooldownMs = COOLDOWN_MS,
                graceMs = LEAVE_GRACE_MS,
                settleMs = PINCH_SETTLE_MS,
                memoryMs = PINCH_MEMORY_MS,
                maxGapMs = MAX_STEP_GAP_MS,
              }: SelectorOptions = {}) {
    this.dwellMs = dwellMs;
    this.cooldownMs = cooldownMs;
    this.graceMs = graceMs;
    this.settleMs = settleMs;
    this.memoryMs = memoryMs;
    this.maxGapMs = maxGapMs;
  }

  step({
         hover,
         pinchDown = false,
         pinched = false,
         now
       }: SelectorInput): SelectorStep {
    if (this.last !== null && (now < this.last || now - this.last > this.maxGapMs)) {
      this.reset();
    }
    this.last = now;
    this.trackHover(hover, now);

    if (pinchDown) {
      const id = this.pinchTarget(hover, now);
      if (id !== null) {
        return this.pick(id, 'pinch', now, hover);
      }
    }

    // While the fingers are closed the cursor is "pressed": the fingertip drifts as they close, and
    // that drift must not start a hover on the neighbouring tile.
    let dwellHover = pinched ? null : hover;
    if (this.blocked !== null) {
      if (hover === this.blocked) {
        this.blockedAwaySince = null;
        if (now >= this.blockedUntil) {
          this.clearBlock();
        } else {
          dwellHover = null;
        }
      } else {
        // Leaving counts only once it has lasted the grace, like everywhere else.
        this.blockedAwaySince ??= now;
        if (now - this.blockedAwaySince >= this.graceMs) {
          this.clearBlock();
        }
      }
    }

    let started = false;
    if (dwellHover !== this.current) {
      if (dwellHover === null) {
        this.awaySince ??= now;
        if (now - this.awaySince >= this.graceMs) {
          this.clearDwell();
        }
      } else {
        // Moving straight to another target restarts the hover at once; only a gap in between gets a
        // grace.
        this.current = dwellHover;
        this.since = now;
        this.awaySince = null;
        this.halfDone = false;
        started = true;
      }
    } else {
      this.awaySince = null;
    }

    if (this.current === null) {
      return {
        hovered: hover,
        target: null,
        progress: 0,
        started,
        halfway: false,
        picked: null,
        via: null,
      };
    }
    const progress = Math.min(1, (now - this.since) / this.dwellMs);
    // Only a cursor that is on the target charges and picks it, not one in the middle of a slip.
    const onTarget = dwellHover === this.current;
    if (onTarget && progress >= 1) {
      return this.pick(this.current, 'dwell', now, hover);
    }
    let halfway = false;
    if (onTarget && !this.halfDone && progress >= 0.5) {
      this.halfDone = true;
      halfway = true;
    }
    return {
      hovered: hover,
      target: this.current,
      progress,
      started,
      halfway,
      picked: null,
      via: null,
    };
  }

  // Forgets the dwell, the cooldown and the pinch memory: a new question, or the game resuming from a
  // pause or a reveal.
  reset(): void {
    this.clearDwell();
    this.clearBlock();
    this.resting = null;
    this.restingSince = 0;
    this.left = null;
    this.last = null;
  }

  private pick(
    id: string,
    via: 'dwell' | 'pinch',
    now: number,
    hover: string | null,
  ): SelectorStep {
    this.blocked = id;
    this.blockedUntil = now + this.cooldownMs;
    this.blockedAwaySince = null;
    this.clearDwell();
    this.left = null;
    return {
      hovered: hover,
      target: null,
      progress: 0,
      started: false,
      halfway: false,
      picked: id,
      via,
    };
  }

  private trackHover(hover: string | null, now: number): void {
    if (hover === this.resting) {
      return;
    }
    if (this.resting !== null) {
      this.left = {
        id: this.resting,
        at: now
      };
    }
    this.resting = hover;
    this.restingSince = now;
  }

  private pinchTarget(hover: string | null, now: number): string | null {
    const earlier = this.left !== null && now - this.left.at <= this.memoryMs ? this.left.id : null;
    if (hover === null) {
      return earlier;
    }
    if (now - this.restingSince < this.settleMs && earlier !== null && earlier !== hover) {
      return earlier;
    }
    return hover;
  }

  private clearDwell(): void {
    this.current = null;
    this.awaySince = null;
    this.halfDone = false;
  }

  private clearBlock(): void {
    this.blocked = null;
    this.blockedAwaySince = null;
  }
}

// ---- Completion ---------------------------------------------------------------------------------

// Reports a finished sentence once, `delayMs` after it was completed, and not at all if a tile was
// taken back in between (the timer starts over when it is completed again).
export class CompletionTimer {
  private since: number | null = null;
  private fired = false;

  constructor(private readonly delayMs = COMPLETE_DELAY_MS) {
  }

  // True on the one step where the delay has passed.
  step(complete: boolean, now: number): boolean {
    if (!complete) {
      this.since = null;
      return false;
    }
    if (this.fired) {
      return false;
    }
    this.since ??= now;
    if (now - this.since < this.delayMs) {
      return false;
    }
    this.fired = true;
    return true;
  }

  reset(): void {
    this.since = null;
    this.fired = false;
  }
}
