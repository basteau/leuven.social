/**
 * The strip of paving between a wall and the pavement or square in front of it. GRB road surfaces
 * and OSM squares stop a hand's breadth or a metre short of the survey's walls here and there,
 * and the slab's garden green showed through as a sliver of lawn at the foot of a shop front.
 * A rule of the bake's, not a layer's: a strip is more of the surface it closes against, so a
 * square's is more of the square and a road's more pavement, and the map gets no new layer and
 * pays only for the rectangles.
 */

import { signedArea } from './geometry.ts';

/**
 * How far a gap at the foot of a wall may reach and still be paved over (m): a road's edge a
 * metre and a half from a wall is a survey's gap, any wider is a front garden; on a square,
 * where nobody gardens, up to three.
 */
const GAP = { road: 1.5, square: 3 } as const;
/** Where along a wall we look (m), how far out in steps of how much, and from where. */
const STEP = 0.75;
const LOOK = 3.15;
const START = 0.15;
const LOOK_STEP = 0.15;
/** How far a strip runs under its wall and the surface beyond it, so no seam shows (m). */
const OVERLAP = 0.2;
const INTO_WALL = 0.05;

export interface ApronTests {
  /** The bare ground of the slab: no layer on it, and no building. */
  base(x: number, z: number): boolean;
  /** What surface lies here, if it's a paved one. */
  paved(x: number, z: number): 'road' | 'square' | null;
}

/** A strip of paving: a flat [x, z, …] rectangle, and what it is more of. */
export interface Apron {
  ring: number[];
  surface: 'road' | 'square';
}

/** The rectangles paving the gaps at the foot of a footprint's walls. */
export function wallAprons(ring: ArrayLike<number>, tests: ApronTests): Apron[] {
  const out = signedArea(ring) > 0 ? -1 : 1;
  const strips: Apron[] = [];
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    const [ax, az, bx, bz] = [ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!];
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 1) continue;
    const [ux, uz] = [(bx - ax) / length, (bz - az) / length];
    const [nx, nz] = [-uz * out, ux * out];
    // Contiguous samples with a gap become one rectangle, as wide as its widest sample.
    let run: { t0: number; t1: number; width: number; surface: 'road' | 'square' } | null = null;
    const close = () => {
      if (!run) return;
      const [t0, t1] = [Math.max(0, run.t0 - OVERLAP), Math.min(length, run.t1 + OVERLAP)];
      const [near, far] = [-INTO_WALL, run.width + OVERLAP];
      strips.push({
        ring: [
          [t0, near],
          [t1, near],
          [t1, far],
          [t0, far],
        ].flatMap(([t, d]) => [ax + ux * t! + nx * d!, az + uz * t! + nz * d!]),
        surface: run.surface,
      });
      run = null;
    };
    for (let t = 0.3; t < length - 0.2; t += STEP) {
      const gap = gapAt(ax + ux * t, az + uz * t, nx, nz, tests);
      if (!gap) close();
      else if (run) {
        run.t1 = t;
        run.width = Math.max(run.width, gap.width);
        if (gap.surface === 'square') run.surface = 'square';
      } else run = { t0: t, t1: t, width: gap.width, surface: gap.surface };
    }
    close();
  }
  return strips;
}

/** The gap at a wall's foot, looking out along (nx, nz), and what it closes against. */
function gapAt(
  x: number,
  z: number,
  nx: number,
  nz: number,
  tests: ApronTests,
): { width: number; surface: 'road' | 'square' } | null {
  if (!tests.base(x + nx * START, z + nz * START)) return null;
  for (let d = START + LOOK_STEP; d <= LOOK; d += LOOK_STEP) {
    const [px, pz] = [x + nx * d, z + nz * d];
    const paved = tests.paved(px, pz);
    if (paved) return d <= GAP[paved] ? { width: d, surface: paved } : null;
    if (!tests.base(px, pz)) return null;
  }
  return null;
}
