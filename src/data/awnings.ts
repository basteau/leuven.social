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
