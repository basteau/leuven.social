/**
 * Reading back what a tap touched. The avatar layer draws the one pixel under the tap with three's
 * depth material, whose `RGBADepthPacking` spreads the depth (0 at the near plane, 1 at the far)
 * over four bytes, most significant first; this turns them back into it. Pure, so the format is
 * tested rather than trusted.
 */

/** The depth packed into four bytes (as `packDepthToRGBA` writes them), or NaN for nothing hit. */
export function unpackDepth(r: number, g: number, b: number, a: number): number {
  // Cleared to white: the pixel shows nothing but sky.
  if (r === 255 && g === 255 && b === 255 && a === 255) return Number.NaN;
  return r / 256 + g / 256 ** 2 + b / 256 ** 3 + a / 255 / 256 ** 3;
}
