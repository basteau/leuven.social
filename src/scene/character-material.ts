import { GreaterDepth, MeshBasicMaterial, MeshToonMaterial } from 'three';
import type { Texture, WebGLProgramParametersWithUniforms } from 'three';

import { BAYER as DITHER } from './facade-material.ts';
import { linearVertexColors } from './mesh-builder.ts';
import { WALKER } from './palette.ts';

/** Every other pixel, in a checkerboard: see-through without blending or sorting. */
const CHECKER = 'mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) < 1.0';

/**
 * A 4×4 ordered dither (0 to 15/16 across each block of pixels): dropping the pixels whose value
 * is at least `fade` draws the figure at that opacity in 16 even steps, still without blending.
 */
const BAYER = `uniform float fade;\n${DITHER}`;
const FADED = 'bayer4(gl_FragCoord.xy) >= fade';

/** How much of the figure to draw, 0 to 1: shared by its materials. */
export interface Fade {
  value: number;
}

function withDither(shader: WebGLProgramParametersWithUniforms, fade: Fade, discard: string): void {
  shader.uniforms.fade = fade;
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nattribute float dither;\nvarying float vDither;\nvarying float vHeight;',
    )
    .replace(
      '#include <skinning_vertex>',
      '#include <skinning_vertex>\nvDither = dither;\nvHeight = transformed.y;',
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>\nvarying float vDither;\nvarying float vHeight;\n${BAYER}`,
    )
    .replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>\nif (${FADED}) discard;\n${discard}`,
    );
}

/**
 * The walker's toon material: its blob shadow (the `dither` vertices) is a pixel checkerboard,
 * and all of it dithers away as `fade` drops, for a camera squeezed up against it.
 */
export function createCharacterMaterial(gradientMap: Texture, fade: Fade): MeshToonMaterial {
  const material = new MeshToonMaterial({ vertexColors: true, gradientMap });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = linearVertexColors(shader.vertexShader);
    withDither(shader, fade, `if (vDither > 0.5 && ${CHECKER}) discard;`);
  };
  material.customProgramCacheKey = () => 'walker-v2';
  return material;
}

/**
 * The avatar's silhouette where a house hides it, as Diablo IV draws its hero: a flat fill in
 * its shirt's coral, half see-through, drawn only where something nearer already filled the depth
 * buffer, so it shows nothing in an open street and the houses themselves never change. One
 * small mesh, so its blending costs nothing to speak of.
 */
export function createXrayMaterial(fade: Fade): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    color: WALKER.shirt,
    depthFunc: GreaterDepth,
    depthWrite: false,
    transparent: true,
    opacity: 0.45,
  });
  // Not the blob shadow or the soles: mid-stride their corners dip into the street, which isn't
  // hiding them.
  material.onBeforeCompile = (shader) =>
    withDither(shader, fade, 'if (vDither > 0.5 || vHeight < 0.25) discard;');
  material.customProgramCacheKey = () => 'walker-xray-v3';
  return material;
}
