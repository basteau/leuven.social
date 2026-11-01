import { ShaderChunk } from 'three';

/**
 * Hard shadows with a soft edge: three's PCF shadows read five hardware-filtered taps spread
 * over a disc that turns with each pixel; with a radius of 0 they all land on one spot. This
 * reads four instead, in a fixed rotated square about a texel across. Each filtered tap blends
 * the four nearest texels, so together they give a shadow's edge a ramp of about three texels:
 * soft at the rim, still no penumbra (DESIGN.md), and no per-pixel rotation to shimmer as the
 * view moves. Four lookups where plain hard shadows take one.
 */

const FIVE_TAPS =
  /\(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample\( 0, 5, phi \) \* radius, shadowCoord\.z \) \) \+[\s\S]*?\) \* 0\.2;/;

/** Where the four taps fall, in shadow texels: a square turned by about 21°. */
const SQUARE = [
  [-0.35, -0.9],
  [0.9, -0.35],
  [0.35, 0.9],
  [-0.9, 0.35],
] as const;

const tap = ([x, y]: readonly [number, number]) =>
  `texture( shadowMap, vec3( shadowCoord.xy + vec2( ${x.toFixed(2)}, ${y.toFixed(2)} ) * texelSize, shadowCoord.z ) )`;

const FOUR_TAPS = `( ${SQUARE.map(tap).join(' + ')} ) * 0.25;`;

/** The shadow chunk with its sun and spot shadows read in four fixed taps; unchanged if not found. */
export function fourTapShadows(chunk: string): string {
  return chunk.replace(FIVE_TAPS, FOUR_TAPS);
}

/** Applies it to three's own chunk, before any shader compiles. */
export function applyFourTapShadows(): void {
  ShaderChunk.shadowmap_pars_fragment = fourTapShadows(ShaderChunk.shadowmap_pars_fragment);
}
