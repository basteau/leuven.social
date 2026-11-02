/**
 * The parked bikes, as the street furniture notes them (`buildFurniture`, `PARKED` in props.ts):
 * finding the one nearest the walker, for walk mode to fetch riding's chunk on the way to a rack
 * and for riding to take one. Small, so walk mode carries it.
 */

/** Each parked bike's numbers in a furniture mesh's `userData.bikes`, as props.ts writes them. */
export const PARKED = { from: 0, to: 1, x: 2, y: 3, z: 4, heading: 5, look: 6, stride: 7 } as const;

/** A cell's furniture mesh, as far as finding its bikes goes. */
export interface Furniture {
  userData: { bikes?: Float32Array };
  geometry: {
    boundingBox: { min: { x: number; z: number }; max: { x: number; z: number } } | null;
  };
}

/** A parked bike: the furniture it's drawn in and where its numbers start there. */
export interface Found {
  mesh: Furniture;
  at: number;
  distance: number;
}

/**
 * The parked bike nearest (x, z) within `reach` metres, among the scene's furniture, skipping
 * any `skip` says (taken already); null if none.
 */
export function nearestParked(
  children: readonly object[],
  x: number,
  z: number,
  reach: number,
  skip?: (bikes: Float32Array, at: number) => boolean,
): Found | null {
  let best: Found | null = null;
  let most = reach;
  for (const child of children) {
    const { bikes } = (child as Furniture).userData;
    const box = (child as Furniture).geometry?.boundingBox;
    if (!bikes?.length || !box) continue;
    if (
      x < box.min.x - most ||
      x > box.max.x + most ||
      z < box.min.z - most ||
      z > box.max.z + most
    )
      continue;
    for (let at = 0; at < bikes.length; at += PARKED.stride) {
      const d = Math.hypot(bikes[at + PARKED.x]! - x, bikes[at + PARKED.z]! - z);
      if (d >= most || skip?.(bikes, at)) continue;
      most = d;
      best = { mesh: child as Furniture, at, distance: d };
    }
  }
  return best;
}

/** A parked bike's heading as the walker counts it (0 facing +z), from its noted turn. */
export const parkedHeading = (turn: number) => Math.atan2(Math.cos(turn), Math.sin(turn));

/** Where the bikes someone left about the city are remembered for the visit. */
export const DROPPED_KEY = 'leuven-dropped-bikes';
