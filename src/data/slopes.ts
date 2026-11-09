/**
 * Buildings on a slope. A building stands on the lowest ground under its corners, and the survey's
 * height is over the ground round it, so a wide, low one on a hillside is buried on its uphill
 * side, the ground coming through its roof where the rise is more than its walls. Its walls are
 * raised so most of them show on the high side too, and the low side gets a taller wall, as a
 * building cut into a hillside has.
 */

import { pointInRing } from './geometry.ts';
import type { Terrain } from './terrain.ts';

/** What part of a building's wall stays above the ground on its uphill side. */
const SHOWN = 0.8;
/** The most a wall is raised (m): past this the low side would be a cliff, for a few long sheds. */
const MOST_RAISED = 14;
/** Less than this doesn't show (m), and a terrace is better left at its neighbours' heights. */
const LEAST_RAISED = 0.5;

/**
 * The highest the landform gets under a footprint: along its walls, and at the terrain's own
 * points inside it, where a ridge would come through its roof.
 */
export function groundTop(ring: ArrayLike<number>, terrain: Terrain): number {
  const n = ring.length / 2;
  let [high, minX, minZ, maxX, maxZ] = [-Infinity, Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [ax, az, bx, bz] = [ring[i * 2]!, ring[i * 2 + 1]!, ring[j * 2]!, ring[j * 2 + 1]!];
    [minX, maxX] = [Math.min(minX, ax), Math.max(maxX, ax)];
    [minZ, maxZ] = [Math.min(minZ, az), Math.max(maxZ, az)];
    // At the terrain's own edges too: between them the ground is straight, so that's its highest.
    for (const p of terrain.cut([ax, 0, az], [bx, 0, bz])) {
      high = Math.max(high, terrain.plain(p[0]!, p[2]!));
    }
  }
  const { step, minX: left, minZ: top } = terrain;
  for (let c = Math.ceil((minX - left) / step); left + c * step <= maxX; c++) {
    for (let r = Math.ceil((minZ - top) / step); top + r * step <= maxZ; r++) {
      const [x, z] = [left + c * step, top + r * step];
      if (pointInRing(ring, x, z)) high = Math.max(high, terrain.plain(x, z));
    }
  }
  return high;
}

/** How much a wall `wall` metres tall over a footprint on `terrain` is raised (m), 0 on the level. */
export function raiseOnSlope(ring: ArrayLike<number>, wall: number, terrain: Terrain): number {
  const spread = groundTop(ring, terrain) - terrain.base(ring);
  const raised = Math.min(MOST_RAISED, spread - (1 - SHOWN) * wall);
  return raised < LEAST_RAISED ? 0 : raised;
}
