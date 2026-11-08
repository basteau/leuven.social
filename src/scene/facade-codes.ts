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
 * - ROOF_FLAT: a flat roof's gravel and bitumen.
 * - PANE: a window on a roof: glass by day, and at night a lit room in about two of three.
 * - CROWN: a tree's crown, which the puffs of leaves (tree-puffs.ts) cover up close.
 *
 * Negative values are the ground's: road textures and paint (paint.ts), sleepers from
 * -SLEEPER_CODE (rails.ts).
 */

export const LANCETS = 400;
export const ORNATE = 600;
export const SHOP_FRONT = 1000;
export const AWNING = 3000;
export const ROOF = 5000;
export const ROOF_FLAT = 5600;
export const CROWN = 5700;
export const PANE = 5800;

/** A wall `top` metres high over a shop front of the kind at `kind` in SHOP_KINDS. */
export const shopFront = (kind: number, top: number): number => SHOP_FRONT + 100 * kind + top;

/** A pitched roof whose ridge stands at `ridge` metres in the world (the shader counts rows from it). */
export const pitchedRoof = (ridge: number): number => ROOF + 100 + ridge;
