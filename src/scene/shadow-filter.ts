import { ShaderChunk } from 'three';

/**
 * Hard shadows without stair-steps: three's PCF shadows read five hardware-filtered taps spread
 * over a disc; with a radius of 0 they all land on one spot. This makes that one tap. A filtered
 * tap blends the four nearest texels, so a shadow's edge is a one-texel ramp instead of a step,
 * still with no penumbra: the shadows stay hard (DESIGN.md), at the cost of a single lookup.
 */

const FIVE_TAPS =
  /\(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample\( 0, 5, phi \) \* radius, shadowCoord\.z \) \) \+[\s\S]*?\) \* 0\.2;/;

/** The shadow chunk with its sun and spot shadows read in one filtered tap; unchanged if not found. */
export function oneTapShadows(chunk: string): string {
  return chunk.replace(FIVE_TAPS, 'texture( shadowMap, vec3( shadowCoord.xy, shadowCoord.z ) );');
}

/** Applies it to three's own chunk, before any shader compiles. */
export function applyOneTapShadows(): void {
  ShaderChunk.shadowmap_pars_fragment = oneTapShadows(ShaderChunk.shadowmap_pars_fragment);
}
