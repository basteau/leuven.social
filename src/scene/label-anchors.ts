import type { Building } from '../data/city.ts';
import { pointInRing } from '../data/geometry.ts';
import { LANDMARK_MODELS } from './landmark-models.ts';
import type { LandmarkModel } from './landmarks.ts';

/** Labels are bucketed by 100 m square, so each footprint only meets the few labels near it. */
const square = (v: number) => Math.floor(v / 100);

/** How far above what it names a label's tick ends (m). */
export const LABEL_MARGIN = 4;

/** The highest point of a hand-made landmark: its base, roof ridges and spire tips. */
export function modelTop(model: LandmarkModel): number {
  return Math.max(
    model.base,
    ...model.parts.map((p) => (p.type === 'hall' ? (p.ridge ?? p.eave) : Math.max(p.top, p.tip))),
  );
}

/**
 * Where each label's tick points: just above the top of the building it stands on (a
 * landmark's spire, a church's roof), or just above the ground for a square, a park or a
 * statue. A fixed height floated labels for low things over whatever stood behind them:
 * Fonske's landed on Sint-Pieterskerk. One pass over the buildings for all labels.
 */
export function labelHeights(
  labels: readonly { x: number; z: number }[],
  buildings: readonly Building[],
): number[] {
  const tops = labels.map(() => 0);
  const near = new Map<string, number[]>();
  for (const [i, { x, z }] of labels.entries()) {
    const key = `${square(x)},${square(z)}`;
    near.set(key, [...(near.get(key) ?? []), i]);
  }
  for (const b of buildings) {
    // Plain loops: this runs on the viewer's startup path, over every footprint.
    const ring = b.ring;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < ring.length; k += 2) {
      const x = ring[k]!;
      const z = ring[k + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    for (let sx = square(minX); sx <= square(maxX); sx++) {
      for (let sz = square(minZ); sz <= square(maxZ); sz++) {
        for (const i of near.get(`${sx},${sz}`) ?? []) {
          const { x, z } = labels[i]!;
          if (x < minX || x > maxX || z < minZ || z > maxZ || !pointInRing(ring, x, z)) continue;
          const model = LANDMARK_MODELS.get(b.id);
          tops[i] = Math.max(tops[i]!, model ? Math.max(b.height, modelTop(model)) : b.height);
        }
      }
    }
  }
  return tops.map((top) => top + LABEL_MARGIN);
}
