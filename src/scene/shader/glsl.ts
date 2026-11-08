/**
 * What every shader in the scene shares: how a number is written into GLSL, the ordered dither that
 * stands in for blending, and value noise from world position. docs/RENDERING.md, "Surfaces".
 */

/** A number as GLSL wants it, with its point. */
export const f = (v: number): string => v.toFixed(4);

/** A 4×4 ordered dither: a threshold from 0 to 15/16 for each pixel of a block. */
export const BAYER = `float bayer2(vec2 a) { a = mod(floor(a), 2.0); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }`;

/** A hash of a cell, and value noise over cells of size 1, smooth between them. */
export const NOISE = `float hash2(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x),
             mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}`;
