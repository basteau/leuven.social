import {
  CustomBlending,
  GreaterDepth,
  MeshBasicMaterial,
  MeshToonMaterial,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
} from 'three';
import type {
  MeshBasicMaterialParameters,
  Texture,
  WebGLProgramParametersWithUniforms,
} from 'three';

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
 * buffer, so it shows nothing in an open street and the houses themselves never change.
 *
 * It has to draw before the figure (its `renderOrder` is lower), or the figure's own front would
 * count as something nearer and the fill would lie over it as a glow. three draws everything
 * `transparent` after everything opaque, whatever the order, so it blends without being
 * transparent: custom blending, the same sums as normal blending, in the opaque pass.
 */
export const XRAY_LOOK: MeshBasicMaterialParameters = {
  color: WALKER.shirt,
  depthFunc: GreaterDepth,
  depthWrite: false,
  opacity: 0.45,
  blending: CustomBlending,
  blendSrc: SrcAlphaFactor,
  blendDst: OneMinusSrcAlphaFactor,
};

/** The silhouette in `color`: by default the avatar's shirt, another player's in theirs. */
export function createXrayMaterial(fade: Fade, color: number = WALKER.shirt): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ ...XRAY_LOOK, color });
  // Not the blob shadow or the soles: mid-stride their corners dip into the street, which isn't
  // hiding them.
  material.onBeforeCompile = (shader) =>
    withDither(shader, fade, 'if (vDither > 0.5 || vHeight < 0.25) discard;');
  material.customProgramCacheKey = () => 'walker-xray-v3';
  return material;
}
