/**
 * Small outbuildings under a tree. The LiDAR height of a footprint is the top of whatever stands
 * on it, and over a garden shed that is often the tree's canopy: a 12 m² shed turns into a
 * 15 m tower. A footprint that is small, stands alone and has a LiDAR crown of about its height
 * right next to it is measuring the tree, so its height is capped to what a shed of that size
 * could be. Real towers and chimneys have no crown beside them and keep theirs.
 */

import { pushTo, signedArea } from './geometry.ts';

/** Footprints below this area (m²) can be sheds. */
const SHED_AREA = 60;
/** A crown this close to the footprint's centre (m) and at least its height minus `CANOPY_SLACK`. */
const CANOPY_REACH = 8;
const CANOPY_SLACK = 4;
/** Corners of two footprints this close (m) mean they touch: row houses, not a shed. */
const TOUCH = 1;

const key = (x: number, z: number) => `${Math.floor(x / 2)},${Math.floor(z / 2)}`;

/** The tallest a shed of this footprint area plausibly is (m). */
export const shedHeight = (area: number): number => Math.max(3, 1.5 * Math.sqrt(area));

interface Footprint {
  ring: ArrayLike<number>;
  height: number;
  eave: number;
}

/**
 * Caps the heights of sheds that measured a tree instead (see above), in place. `crowns` are
 * [x, z, height] from the LiDAR. Returns how many it capped.
 */
export function capShedsUnderTrees(
  buildings: Footprint[],
  crowns: readonly (readonly [number, number, number])[],
): number {
  const grid = new Map<string, number[]>();
  for (const [i, { ring }] of buildings.entries()) {
    for (let k = 0; k < ring.length; k += 2) {
      pushTo(grid, key(ring[k]!, ring[k + 1]!), i);
    }
  }
  const touches = (i: number): boolean => {
    const { ring } = buildings[i]!;
    for (let k = 0; k < ring.length; k += 2) {
      const [x, z] = [ring[k]!, ring[k + 1]!];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const near = grid.get(`${Math.floor(x / 2) + dx},${Math.floor(z / 2) + dz}`) ?? [];
          for (const j of near) {
            if (j === i) continue;
            const other = buildings[j]!.ring;
            for (let m = 0; m < other.length; m += 2) {
              if (Math.hypot(other[m]! - x, other[m + 1]! - z) < TOUCH) return true;
            }
          }
        }
      }
    }
    return false;
  };

  let capped = 0;
  for (const [i, b] of buildings.entries()) {
    const area = signedArea(b.ring);
    const cap = shedHeight(area);
    if (area >= SHED_AREA || b.height <= cap) continue;
    let [cx, cz] = [0, 0];
    for (let k = 0; k < b.ring.length; k += 2) [cx, cz] = [cx + b.ring[k]!, cz + b.ring[k + 1]!];
    [cx, cz] = [cx / (b.ring.length / 2), cz / (b.ring.length / 2)];
    const underTree = crowns.some(
      ([x, z, h]) => h >= b.height - CANOPY_SLACK && Math.hypot(x - cx, z - cz) < CANOPY_REACH,
    );
    if (!underTree || touches(i)) continue;
    b.height = cap;
    b.eave = Math.min(b.eave, cap);
    capped++;
  }
  return capped;
}
