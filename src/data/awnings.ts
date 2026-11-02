/**
 * How far a shop front's awning reaches along its wall (src/scene/storefronts.ts draws it), and
 * its name board with it (src/data/boards.ts). A module of its own: the furniture chunk and the
 * bake share it, and walk mode's share of shops.ts stays as it was.
 */

/**
 * An awning (src/scene/storefronts.ts) reaches at most this far each side of its front (m), and
 * stops this far short of its wall's ends.
 */
export const AWNING_HALF = 2.5;
export const END_GAP = 0.3;
/** A front with no more room than this each side (m) gets neither awning nor name board. */
export const MIN_ROOM = 0.4;

/**
 * How far a front's awning, and its name board, reach each side of it (m): up to AWNING_HALF,
 * short of its wall's ends, and halfway to the next front along the same wall (`others`, how far
 * along it each is).
 */
export function awningRoom(along: number, length: number, others: readonly number[]): number {
  return Math.min(
    AWNING_HALF,
    along - END_GAP,
    length - END_GAP - along,
    ...others.map((o) => Math.abs(o - along) / 2),
  );
}

/**
 * Potted bay trees either side of a café's, bar's or restaurant's door (src/scene/storefronts.ts
 * draws them; walk mode meets each as a post): `along` each side of the front's middle, `out`
 * from its wall, pots `radius` round. A front needs room for them, and none where its terrace is.
 */
export const DOOR_PLANT = { along: 0.95, out: 0.4, radius: 0.24 } as const;
const PLANTED = new Set(['cafe', 'bar', 'restaurant']);

/** Where a front's door plants stand (x, z pairs), given its point on the wall and its room. */
export function doorPlants(
  p: { x: number; z: number; ux: number; uz: number; nx: number; nz: number },
  front: { kind: string; terrace: boolean },
  room: number,
): number[] {
  if (!PLANTED.has(front.kind) || front.terrace || room < DOOR_PLANT.along + DOOR_PLANT.radius) {
    return [];
  }
  const { along, out } = DOOR_PLANT;
  return [-1, 1].flatMap((s) => [
    p.x + p.ux * s * along + p.nx * out,
    p.z + p.uz * s * along + p.nz * out,
  ]);
}
