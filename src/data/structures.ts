/**
 * GRB structures (KNW) that aren't buildings: bridges, tanks and silos, masts. Bridges are
 * already road or path on the map; what makes one read as a bridge is its parapets, the low
 * walls along the sides that face the water.
 */

import type { Deck } from './city.ts';
import type { RingIndex } from './props.ts';
import type { Strip } from './terrain.ts';

/** How far outside an edge to look for the water it faces (m). */
const LOOK = 1;
/** Shorter stretches of parapet are survey slivers, a pixel or two even up close (m). */
const MIN_PARAPET = 2;

/**
 * The sides of a bridge (a counter-clockwise ring in x, z) that face the water in `water`:
 * runs of edges whose outside is river, each as an open line. Bank sides, and every side of a
 * bridge over a road or a railway, get none.
 */
export function bridgeParapets(ring: ArrayLike<number>, water: RingIndex): number[][] {
  const n = ring.length / 2;
  const wet = Array.from({ length: n }, (_, i) => {
    const j = (i + 1) % n;
    const [ax, az, bx, bz] = [ring[i * 2]!, ring[i * 2 + 1]!, ring[j * 2]!, ring[j * 2 + 1]!];
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 1e-6) return false;
    // Counter-clockwise in (x, z), the outside of an edge lies to its right: (dz, -dx).
    const [ox, oz] = [((bz - az) / length) * LOOK, (-(bx - ax) / length) * LOOK];
    return water.contains((ax + bx) / 2 + ox, (az + bz) / 2 + oz);
  });
  // Start the walk after a dry edge, so a run that wraps past the ring's start stays whole.
  const start = wet.indexOf(false);
  if (start < 0) return [];
  const runs: number[][] = [];
  let run: number[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (wet[i]) {
      if (!run.length) run.push(ring[i * 2]!, ring[i * 2 + 1]!);
      const j = (i + 1) % n;
      run.push(ring[j * 2]!, ring[j * 2 + 1]!);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  return runs.filter((line) => {
    let length = 0;
    for (let i = 2; i < line.length; i += 2) {
      length += Math.hypot(line[i]! - line[i - 2]!, line[i + 1]! - line[i - 1]!);
    }
    return length >= MIN_PARAPET;
  });
}

/** Tanks keep at most this many corners: enough for a round one to look round. */
export const TANK_CORNERS = 12;

/**
 * A tank's footprint with at most `TANK_CORNERS` corners, evenly spread. The survey draws round
 * tanks with dozens of points; dropping near-collinear ones (as for buildings) would collapse
 * a circle, where every point is nearly in line with its neighbours.
 */
export function tankOutline(ring: ArrayLike<number>): number[] {
  const n = ring.length / 2;
  const step = Math.max(1, n / TANK_CORNERS);
  const out: number[] = [];
  for (let k = 0; k < Math.min(n, TANK_CORNERS); k++) {
    const i = Math.floor(k * step);
    out.push(ring[i * 2]!, ring[i * 2 + 1]!);
  }
  return out;
}

/** A deck's edge counts as an end this far past where its width reaches from its axis's end (m). */
const END_REACH = 6;

/** Which of a deck's outline edges are its open ends: roughly across its axis, at an end of it. */
export function deckEnds(deck: Deck): boolean[] {
  const { ring, axis } = deck;
  const n = ring.length / 2;
  const last = axis.length / 2 - 1;
  const reach = deckReach(deck) + END_REACH;
  const ends = [
    [axis[0]!, axis[1]!, axis[2]! - axis[0]!, axis[3]! - axis[1]!],
    [
      axis[last * 2]!,
      axis[last * 2 + 1]!,
      axis[last * 2]! - axis[(last - 1) * 2]!,
      axis[last * 2 + 1]! - axis[(last - 1) * 2 + 1]!,
    ],
  ] as const;
  return Array.from({ length: n }, (_, i) => {
    const j = (i + 1) % n;
    const [ax, az, bx, bz] = [ring[i * 2]!, ring[i * 2 + 1]!, ring[j * 2]!, ring[j * 2 + 1]!];
    const [dx, dz] = [bx - ax, bz - az];
    const len = Math.hypot(dx, dz) || 1;
    return ends.some(([ex, ez, ux, uz]) => {
      const along = Math.abs((dx * ux + dz * uz) / (len * (Math.hypot(ux, uz) || 1)));
      return along < 0.8 && Math.hypot((ax + bx) / 2 - ex, (az + bz) / 2 - ez) < reach;
    });
  });
}

/** Half the width a deck's outline spreads over (m), from its axis to its furthest corner. */
export function deckReach({ ring, axis }: Pick<Deck, 'ring' | 'axis'>): number {
  let reach = 0;
  for (let i = 0; i + 1 < ring.length; i += 2) {
    const [x, z] = [ring[i]!, ring[i + 1]!];
    let nearest = Infinity;
    for (let k = 0; k + 3 < axis.length; k += 2) {
      const [ax, az, bx, bz] = [axis[k]!, axis[k + 1]!, axis[k + 2]!, axis[k + 3]!];
      const [dx, dz] = [bx - ax, bz - az];
      const t = Math.min(
        1,
        Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)),
      );
      nearest = Math.min(nearest, Math.hypot(ax + dx * t - x, az + dz * t - z));
    }
    reach = Math.max(reach, nearest);
  }
  return reach;
}

/** The strip a deck's surface is carved on, wide enough for its whole outline. */
export const deckStrip = (deck: Deck): Strip => ({
  line: deck.axis,
  rise: deck.rise,
  half: deckReach(deck) + 0.5,
});

/** The stretches of a deck's outline that are its sides, as open lines: its parapets. */
export function deckSides(deck: Deck): number[][] {
  const { ring } = deck;
  const n = ring.length / 2;
  const isEnd = deckEnds(deck);
  const first = isEnd.indexOf(true);
  if (first < 0) return [[...ring, ring[0]!, ring[1]!]];
  const runs: number[][] = [];
  let run: number[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (first + k) % n;
    if (!isEnd[i]) {
      if (!run.length) run.push(ring[i * 2]!, ring[i * 2 + 1]!);
      const j = (i + 1) % n;
      run.push(ring[j * 2]!, ring[j * 2 + 1]!);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  return runs;
}
