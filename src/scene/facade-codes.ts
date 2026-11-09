/**
 * What the `facade` vertex attribute says, every positive range in one place; facade-material.ts
 * reads it back. Walls carry their top height (at most 90 m) on top of a code:
 *
 * - 0: no detail (roofs, trees, the ground's plain layers).
 * - up to 90: a wall with windows in its building's own rhythm.
 * - LANCETS + top: a church wall, with pointed lancets.
 * - ORNATE + top: civic Gothic, as on the Stadhuis: tiers of pointed niches, each with a statue.
 * - SHOP_FRONT + 100 · kind + top: a wall over a shop front of `SHOP_KINDS[kind]`
 *   (src/data/shop-kinds.ts): a glazed ground floor under the kind's awning or fascia.
 * - AWNING + kind: the canvas of a shop's awning (storefronts.ts), striped as its kind is.
 * - ROOF + 100 + the ridge's height in the world: a pitched roof, tiled or slated in its rows.
 * - ROOF_FLAT + a fraction: a flat roof, the fraction how its building is turned (of half a turn).
 * - WALL_PLAIN: a wall with no windows: a gable, a shed, a tower.
 * - PANE: a window on a roof: glass by day, and at night a lit room in about two of three.
 * - CROWN: a tree's crown, which casts its shadow and catches a tap; `addPuffs` (trees.ts) draws it.
 *
 * Negative values are the ground's: road textures and paint (paint.ts), sleepers from
 * -SLEEPER_CODE (rails.ts).
 */

export const LANCETS = 400;
export const ORNATE = 600;
// A shop front's kind is its place in SHOP_KINDS, a hundred per kind: room for 70 kinds between
// here and AWNING. Places have no front of glass, but they share the numbering.
export const SHOP_FRONT = 1000;
export const AWNING = 8000;
export const ROOF = 10000;
export const ROOF_FLAT = 10600;
export const CROWN = 10700;
export const WALL_PLAIN = 10750;
export const PANE = 10800;

/** A wall `top` metres high over a shop front of the kind at `kind` in SHOP_KINDS. */
export const shopFront = (kind: number, top: number): number => SHOP_FRONT + 100 * kind + top;

/** A pitched roof whose ridge stands at `ridge` metres in the world (the shader counts rows from it). */
export const pitchedRoof = (ridge: number): number => ROOF + 100 + ridge;

/** A flat roof over a building turned `angle` radians from the x axis, its seams square to it. */
export function flatRoof(angle: number): number {
  const half = (((angle / Math.PI) % 1) + 1) % 1;
  return ROOF_FLAT + Math.min(half, 0.999);
}
