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

/**
 * The shadow map holds back faces (three draws a one-sided material's far side into it), and
 * the toon ramp still gives faces turned a little from the sun some of its light. So a wall
 * facing away from the sun meets its own depth in the map: three's normal offset pushes its
 * lookup further from the sun, into itself, and a grazing wall breaks into stripes. Offsetting
 * along the normal on the sun's side, whichever way the face is turned, lifts every lookup off
 * its own surface, so the depth bias can stay a few centimetres and low things (benches,
 * bollards) keep their shadows. The sun's direction is the depth row of the shadow matrix.
 */
const NORMAL_OFFSET =
  'shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );';
const SUN_SIDE_OFFSET =
  'shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias * sign( 0.5 - step( 0.0, dot( shadowWorldNormal, vec3( directionalShadowMatrix[ i ][ 0 ].z, directionalShadowMatrix[ i ][ 1 ].z, directionalShadowMatrix[ i ][ 2 ].z ) ) ) ), 0 );';

/** The shadow vertex chunk with the sun's normal offset always toward the sun; unchanged if not found. */
export function sunSideOffset(chunk: string): string {
  return chunk.replace(NORMAL_OFFSET, SUN_SIDE_OFFSET);
}

/** Applies both to three's own chunks, before any shader compiles. */
export function applyShadowChunks(): void {
  ShaderChunk.shadowmap_pars_fragment = fourTapShadows(ShaderChunk.shadowmap_pars_fragment);
  ShaderChunk.shadowmap_vertex = sunSideOffset(ShaderChunk.shadowmap_vertex);
}
