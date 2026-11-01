import type { Building } from '../data/city.ts';
import { pointInRing } from '../data/geometry.ts';
import { LANDMARK_MODELS } from './landmark-models.ts';
import type { LandmarkModel } from './landmarks.ts';

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
 * Where a label's tick points: just above the top of the building it stands on (a landmark's
 * spire, a church's roof), or just above the ground for a square, a park or a statue. A fixed
 * height floated labels for low things over whatever stood behind them: Fonske's landed on
 * Sint-Pieterskerk.
 */
export function labelHeight(x: number, z: number, buildings: readonly Building[]): number {
  let top = 0;
  for (const b of buildings) {
    const model = LANDMARK_MODELS.get(b.id);
    const height = model ? Math.max(b.height, modelTop(model)) : b.height;
    if (height > top && pointInRing(b.ring, x, z)) top = height;
  }
  return top + LABEL_MARGIN;
}
