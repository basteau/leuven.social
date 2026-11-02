/**
 * What the `facade` vertex attribute says, every positive range in one place; facade-material.ts
 * reads it back. Walls carry their top height (at most 90 m) on top of a code:
 *
 * - 0: no detail (roofs, trees, the ground's plain layers).
 * - up to 90: a wall with windows in its building's own rhythm.
 * - LANCETS + top: a church wall, with pointed lancets.
 * - SHOP_FRONT + 100 · kind + top: a wall over a shop front of `SHOP_KINDS[kind]`
 *   (src/data/shop-kinds.ts): a glazed ground floor under the kind's awning or fascia.
 * - AWNING + kind: the canvas of a shop's awning (storefronts.ts), striped as its kind is.
 *
 * Negative values are the ground's: road textures and paint (paint.ts), sleepers from
 * -SLEEPER_CODE (rails.ts).
 */

export const LANCETS = 400;
export const SHOP_FRONT = 1000;
export const AWNING = 3000;

/** A wall `top` metres high over a shop front of the kind at `kind` in SHOP_KINDS. */
export const shopFront = (kind: number, top: number): number => SHOP_FRONT + 100 * kind + top;
