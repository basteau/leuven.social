/**
 * Reading back what a tap touched, and what it means. The avatar layer draws a small square of
 * the scene around the tap with three's depth material (`RGBADepthPacking`, the depth from 0 at the
 * near plane to 1 at the far, over four bytes, most significant first) and unprojects each pixel;
 * `meant` then picks the place meant. Pure, so the format and the choice are tested, not trusted.
 */

/** The depth packed into four bytes (as `packDepthToRGBA` writes them), or NaN for nothing hit. */
export function unpackDepth(r: number, g: number, b: number, a: number): number {
  // Cleared to white: the pixel shows nothing but sky.
  if (r === 255 && g === 255 && b === 255 && a === 255) return Number.NaN;
  return r / 256 + g / 256 ** 2 + b / 256 ** 3 + a / 255 / 256 ** 3;
}

/** What the scene is like at a point, for `meant`. */
export interface MeantTests {
  /** Whether a surface drawn at height y over (x, z) is the ground there, not on it. */
  ground(x: number, y: number, z: number): boolean;
  /** Whether (x, z) is open to walk on. */
  open(x: number, z: number): boolean;
  /** Whether (x, z) is in a building. */
  building(x: number, z: number): boolean;
}

/**
 * Where a tap means to go, from `points`: the surface under each pixel of a `side`×`side` square
 * centred on the tap (x, y, z per pixel, the first row the screen's top; NaN where nothing was
 * hit). Open ground is where it is. A tree, bench, car or figure: the ground under the spot
 * touched. A roof or a wall: 'building', for the caller to find the place beside it. Water, rails,
 * or ground the walk grid gives a building (a sliver at a wall's foot): the nearest open ground
 * that shows in the square, so it's a place the person can see. Null if none does, or if the tap
 * touched nothing.
 */
export function meant(
  points: Float32Array,
  side: number,
  tests: MeantTests,
): [number, number] | 'building' | null {
  const mid = (side - 1) / 2;
  const standing = (x: number, y: number, z: number) => tests.ground(x, y, z) && tests.open(x, z);
  const at = (mid * side + mid) * 3;
  const [x, y, z] = [points[at]!, points[at + 1]!, points[at + 2]!];
  if (Number.isNaN(x)) return null;
  if (standing(x, y, z)) return [x, z];
  if (!tests.ground(x, y, z)) return tests.building(x, z) ? 'building' : [x, z];
  return nearestShown(points, side, standing);
}

/**
 * The pixel of the square (`points`, as for `meant`) nearest its middle whose surface passes
 * `ok`: (x, z) of what it shows, or null if none does.
 */
export function nearestShown(
  points: Float32Array,
  side: number,
  ok: (x: number, y: number, z: number) => boolean,
): [number, number] | null {
  const mid = (side - 1) / 2;
  let best = Infinity;
  let found: [number, number] | null = null;
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const d = Math.hypot(col - mid, row - mid);
      const i = (row * side + col) * 3;
      if (d >= best || Number.isNaN(points[i]!)) continue;
      if (!ok(points[i]!, points[i + 1]!, points[i + 2]!)) continue;
      best = d;
      found = [points[i]!, points[i + 2]!];
    }
  }
  return found;
}
