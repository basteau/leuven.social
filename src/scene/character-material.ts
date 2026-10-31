import { GreaterDepth, MeshBasicMaterial, MeshToonMaterial } from 'three';
import type { Texture, WebGLProgramParametersWithUniforms } from 'three';

import { WALKER } from './palette.ts';

/** Every other pixel, in a checkerboard: half-transparent the pixel-art way, with no blending. */
const CHECKER = 'mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) < 1.0';

function withDither(shader: WebGLProgramParametersWithUniforms, discard: string): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nattribute float dither;\nvarying float vDither;',
    )
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDither = dither;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vDither;')
    .replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>\n${discard}`,
    );
}

/** The walker's toon material: its blob shadow (the `dither` vertices) is a pixel checkerboard. */
export function createCharacterMaterial(gradientMap: Texture): MeshToonMaterial {
  const material = new MeshToonMaterial({ vertexColors: true, gradientMap });
  material.onBeforeCompile = (shader) =>
    withDither(shader, `if (vDither > 0.5 && ${CHECKER}) discard;`);
  material.customProgramCacheKey = () => 'walker-v1';
  return material;
}

/**
 * The walker's silhouette where the city hides it: a checkerboard of coat blue (readable on
 * slate roofs and pale walls alike), drawn only where
 * something nearer already filled the depth buffer, and never for the shadow.
 */
export function createXrayMaterial(): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    color: WALKER.coat,
    depthFunc: GreaterDepth,
    depthWrite: false,
  });
  material.onBeforeCompile = (shader) =>
    withDither(shader, `if (vDither > 0.5 || !(${CHECKER})) discard;`);
  material.customProgramCacheKey = () => 'walker-xray-v1';
  return material;
}
