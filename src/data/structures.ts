/**
 * GRB structures (KNW) that aren't buildings: bridges, tanks and silos, masts. Bridges are
 * already road or path on the map; what makes one read as a bridge is its parapets, the low
 * walls along the sides that face the water.
 */

import type { RingIndex } from './props.ts';

/** How far outside an edge to look for the water it faces (m). */
const LOOK = 1;
/** Shorter stretches of parapet are survey slivers, below a game pixel (m). */
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

/** Tanks keep at most this many corners: a round one is still round at a game pixel. */
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
