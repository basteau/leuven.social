/**
 * People gathered into marks for a drawing where someone is only a few pixels: a dot each where
 * there is room, a bigger disc where a crowd stands. The street's overlay and both maps use it, so
 * a crowd looks the same on all of them.
 *
 * The grid is anchored to the world, not the screen, so panning never moves a clump from one group
 * of people to another: a square of 5 m times a power of two, whichever covers 18 to 36 pixels.
 * Over the last fifth of an octave the two levels crossfade, so zooming never pops. Everything is
 * in flat arrays kept from one call to the next, so a crowd of thousands allocates nothing.
 */

import { INDOORS } from '../net/people.ts';
import type { People } from '../net/people.ts';

export interface ClumpOptions {
  /** How many CSS pixels a metre is on this drawing. */
  pxPerMetre: number;
  /** The ground to look at (m). Pad it by a cell, or a clump on the edge changes as it pans. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Whose room this drawing is of ('' the street), and its floor: only those in it show. */
  place: string;
  floor: number;
  /** A multiplier per slot, as `people` numbers them; 0 leaves someone out. */
  alpha?: Float32Array;
  /** The biggest a clump gets (CSS px), for a drawing small enough that 22 would swamp it. */
  largest?: number;
}

/** What to draw, in drawing order. Read the arrays afresh each call: growing replaces them. */
export interface Marks {
  count: number;
  /** Where (m). */
  x: Float32Array;
  z: Float32Array;
  /** How many people, counting those a thinned-out far crowd stands for. */
  n: Uint32Array;
  /** 24-bit sRGB. */
  colour: Int32Array;
  /** CSS pixels. */
  radius: Float32Array;
  alpha: Float32Array;
  /** A clump is still forming or dissolving: draw again soon, even if nobody moves. */
  settling: boolean;
}

export interface Clumper {
  clump(people: People, options: ClumpOptions): Marks;
}

/** A level's cell is this many metres a side, times two to its power. */
const CELL = 5;
/** The fewest CSS pixels a cell covers; twice this is the most. */
const LEAST_PX = 18;
/** How much of the octave, at its end, the next finer level fades in over. */
const CROSSFADE = 0.2;
/** A cell with this many is one clump. Fewer are dots. */
const CLUMP_FROM = 4;
/** A dot's radius, how fast a clump's grows with each doubling, and the most it gets (px). */
const DOT = 3.5;
const GROWTH = 0.35;
const LARGEST = 22;
/** How long a clump takes to form or dissolve, and to settle on where it has moved to (ms). */
const EASE_MS = 200;

const radiusFor = (n: number, largest: number) =>
  n <= 1 ? DOT : Math.min(largest, DOT * (1 + GROWTH * Math.log2(n)));

/** The cells of one call, an open-addressed table reset by bumping a generation. */
function createCells(size: number) {
  return {
    size,
    generation: 1,
    stamp: new Uint32Array(size),
    key: new Float64Array(size),
    n: new Uint32Array(size),
    sumX: new Float64Array(size),
    sumZ: new Float64Array(size),
    sumAlpha: new Float64Array(size),
    lowest: new Int32Array(size),
    colour: new Int32Array(size),
    /** How much of its level this cell's level is shown, 0 to 1. */
    share: new Float32Array(size),
    /** How much of a clump it is: 0 its members as dots, 1 one disc. */
    clumped: new Float32Array(size),
    shownX: new Float32Array(size),
    shownZ: new Float32Array(size),
    shownRadius: new Float32Array(size),
    /** The slots in use, in the order they were first met, so drawing order holds still. */
    used: new Int32Array(size),
    usedCount: 0,
  };
}

/** The slot of `key`, or the free slot where it would go, as its bitwise not. */
function locate(cells: ReturnType<typeof createCells>, key: number): number {
  const mask = cells.size - 1;
  // Its upper part (the level and i) and its lower part (j), mixed.
  let at = (Math.imul(key / 2 ** 20, 73856093) ^ Math.imul(key % 2 ** 20, 19349663)) & mask;
  while (cells.stamp[at] === cells.generation) {
    if (cells.key[at] === key) return at;
    at = (at + 1) & mask;
  }
  return ~at;
}

const newSize = (people: number) => {
  // A table twice over what two levels of everyone alone could fill.
  let size = 128;
  while (size < people * 4 + 16) size *= 2;
  return size;
};

export function createClumper(clock: () => number = () => performance.now()): Clumper {
  let table = createCells(128);
  let last = createCells(128);
  let lastAt = Number.NEGATIVE_INFINITY;
  let slotAlpha = new Float32Array(64);
  let fineCell = new Int32Array(64);
  let coarseCell = new Int32Array(64);
  const marks: Marks = {
    count: 0,
    x: new Float32Array(64),
    z: new Float32Array(64),
    n: new Uint32Array(64),
    colour: new Int32Array(64),
    radius: new Float32Array(64),
    alpha: new Float32Array(64),
    settling: false,
  };

  function reserve(people: number): void {
    if (fineCell.length < people) {
      const length = Math.max(people, fineCell.length * 2);
      slotAlpha = new Float32Array(length);
      fineCell = new Int32Array(length);
      coarseCell = new Int32Array(length);
    }
    // Everyone a dot once, and at most a clump each on two levels.
    const most = people * 3;
    if (marks.x.length < most) {
      const length = Math.max(most, marks.x.length * 2);
      marks.x = new Float32Array(length);
      marks.z = new Float32Array(length);
      marks.n = new Uint32Array(length);
      marks.colour = new Int32Array(length);
      marks.radius = new Float32Array(length);
      marks.alpha = new Float32Array(length);
    }
  }

  function push(
    x: number,
    z: number,
    n: number,
    colour: number,
    radius: number,
    alpha: number,
  ): void {
    const at = marks.count++;
    marks.x[at] = x;
    marks.z[at] = z;
    marks.n[at] = n;
    marks.colour[at] = colour;
    marks.radius[at] = radius;
    marks.alpha[at] = alpha;
  }

  /** Everyone showing into the cells of a level. Writes which cell each landed in to `into`. */
  function bin(people: People, level: number, share: number, into: Int32Array): void {
    const metres = CELL * 2 ** level;
    const { x, z, ids, colour, weight } = people;
    for (let s = 0; s < people.count; s++) {
      const alpha = slotAlpha[s]!;
      if (alpha === 0) {
        into[s] = -1;
        continue;
      }
      const i = Math.floor(x[s]! / metres);
      const j = Math.floor(z[s]! / metres);
      // Whole numbers well inside a double's 53 bits, for any spot on the map at any level.
      const key = (level + 64) * 2 ** 40 + (i + 2 ** 19) * 2 ** 20 + (j + 2 ** 19);
      let cell = locate(table, key);
      if (cell < 0) {
        cell = ~cell;
        table.stamp[cell] = table.generation;
        table.key[cell] = key;
        table.n[cell] = 0;
        table.sumX[cell] = 0;
        table.sumZ[cell] = 0;
        table.sumAlpha[cell] = 0;
        table.lowest[cell] = 0x7fffffff;
        table.share[cell] = share;
        table.used[table.usedCount++] = cell;
      }
      into[s] = cell;
      const stands = weight[s]!;
      table.n[cell]! += stands;
      table.sumX[cell]! += x[s]! * stands;
      table.sumZ[cell]! += z[s]! * stands;
      table.sumAlpha[cell]! += alpha * stands;
      // The lowest id, so the clump keeps its colour as others come and go.
      if (ids[s]! < table.lowest[cell]!) {
        table.lowest[cell] = ids[s]!;
        table.colour[cell] = colour[s]!;
      }
    }
  }

  /** Each cell eased from what it was last call toward what it is now. */
  function settle(now: number, largest: number): void {
    const ease = now === lastAt ? 0 : Math.min(1, (now - lastAt) / EASE_MS);
    for (let u = 0; u < table.usedCount; u++) {
      const cell = table.used[u]!;
      const n = table.n[cell]!;
      const want = n >= CLUMP_FROM ? 1 : 0;
      const x = table.sumX[cell]! / n;
      const z = table.sumZ[cell]! / n;
      const radius = radiusFor(n, largest);
      const was = locate(last, table.key[cell]!);
      if (was < 0) {
        // New here: nothing to ease from. (Coming into view has `fade`, and a level has its share.)
        table.clumped[cell] = want;
        table.shownX[cell] = x;
        table.shownZ[cell] = z;
        table.shownRadius[cell] = radius;
        continue;
      }
      const from = last.clumped[was]!;
      const step = Math.abs(want - from) <= ease ? want : from + Math.sign(want - from) * ease;
      table.clumped[cell] = step;
      if (step !== want) marks.settling = true;
      table.shownX[cell] = last.shownX[was]! + (x - last.shownX[was]!) * ease;
      table.shownZ[cell] = last.shownZ[was]! + (z - last.shownZ[was]!) * ease;
      table.shownRadius[cell] = last.shownRadius[was]! + (radius - last.shownRadius[was]!) * ease;
    }
  }

  return {
    clump(people, options) {
      const now = clock();
      const { count } = people;
      reserve(count);
      if (table.size < newSize(count)) table = createCells(newSize(count));
      table.generation++;
      table.usedCount = 0;
      marks.count = 0;
      marks.settling = false;

      const { x0, z0, x1, z1, place, floor, alpha, largest = LARGEST } = options;
      const { x, z, fade, flags, weight, colour } = people;
      for (let s = 0; s < count; s++) {
        let shown = fade[s]! * (alpha ? alpha[s]! : 1);
        const px = x[s]!;
        const pz = z[s]!;
        if (px < x0 || px > x1 || pz < z0 || pz > z1) shown = 0;
        else if (flags[s]! & INDOORS && (people.place(s) !== place || people.floor(s) !== floor)) {
          shown = 0;
        }
        slotAlpha[s] = shown;
      }

      // Cells cover 18 px at a fraction of 0, nearly 36 as it comes to 1, where a finer level
      // (18 px again) has come in over the last fifth.
      const exact = Math.log2(LEAST_PX / (CELL * options.pxPerMetre));
      const level = Math.ceil(exact);
      const through = level - exact;
      const fading = through > 1 - CROSSFADE;
      const coarseShare = fading ? (1 - through) / CROSSFADE : 1;
      bin(people, fading ? level - 1 : level, fading ? 1 - coarseShare : 1, fineCell);
      if (fading) bin(people, level, coarseShare, coarseCell);
      settle(now, largest);
      lastAt = now;

      // Clumps first and dots over them, so nobody is lost behind a crowd next to them.
      for (let u = 0; u < table.usedCount; u++) {
        const cell = table.used[u]!;
        const clumped = table.clumped[cell]!;
        if (clumped === 0) continue;
        const n = table.n[cell]!;
        const shown = (table.sumAlpha[cell]! / n) * clumped * table.share[cell]!;
        if (shown > 0) {
          push(
            table.shownX[cell]!,
            table.shownZ[cell]!,
            n,
            table.colour[cell]!,
            table.shownRadius[cell]!,
            shown,
          );
        }
      }
      for (let s = 0; s < count; s++) {
        const own = slotAlpha[s]!;
        if (own === 0) continue;
        // Someone counted once however the levels mix: a dot on both is one dot, not two faint ones.
        const fine = fineCell[s]!;
        let free = (1 - table.clumped[fine]!) * table.share[fine]!;
        if (fading) {
          const coarse = coarseCell[s]!;
          free += (1 - table.clumped[coarse]!) * table.share[coarse]!;
        }
        if (free > 0)
          push(x[s]!, z[s]!, weight[s]!, colour[s]!, radiusFor(weight[s]!, largest), own * free);
      }

      // What this call found is what the next one eases from.
      const spare = last;
      last = table;
      table = spare;
      return marks;
    },
  };
}
