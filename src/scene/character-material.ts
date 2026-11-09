import { GreaterDepth, MeshBasicMaterial, MeshToonMaterial } from 'three';
import type {
  MeshBasicMaterialParameters,
  Texture,
  WebGLProgramParametersWithUniforms,
} from 'three';

import { BAYER as DITHER } from './facade-material.ts';
import { linearVertexColors } from './mesh-builder.ts';
import { TINT_ROLE } from './crowd-mesh.ts';
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

/**
 * One crowd figure's dither, for the fragment shader, by the fade from `motion.z`. Past 0 it is a
 * plain fade, keeping the pixels under it. Under 0 it is a rig's complement: `-fade` is what a
 * rig draws where they swap, so the two together make whole pixels, nothing doubled or missing.
 */
const DITHERED = `(vMotionFade >= 0.0 ? bayer4(gl_FragCoord.xy) >= vMotionFade : bayer4(gl_FragCoord.xy) < -vMotionFade)`;

const CROWD_VERTEX_HEAD = `#include <common>
attribute float facade;
attribute vec3 motion;
attribute vec3 shirt;
attribute vec3 look;
uniform float inkExtra;
varying float vMotionFade;
varying float vPart;
vec3 unpack(float c) {
  return vec3(floor(c / 65536.0), mod(floor(c / 256.0), 256.0), mod(c, 256.0)) / 255.0;
}
void swing(inout vec3 p, float y, float a) {
  float d = p.y - y;
  float e = p.z;
  float c = cos(a);
  float s = sin(a);
  p.y = y + d * c - e * s;
  p.z = d * s + e * c;
}`;

/** Legs and arms swung about the hip and shoulder from each instance's phase and how far. */
const CROWD_BEGIN = `#include <begin_vertex>
float bone = floor(facade);
float role = fract(facade) * 8.0;
vPart = bone;
vMotionFade = motion.z;
if (role > ${(TINT_ROLE.ink - 0.5).toFixed(1)}) transformed -= normal * inkExtra;
float legSwing = sin(motion.x) * 0.6 * motion.y;
if (bone == 8.0) swing(transformed, ${(0.86).toFixed(2)}, legSwing);
else if (bone == 9.0) swing(transformed, ${(0.86).toFixed(2)}, -legSwing);
else if (bone == 4.0) swing(transformed, ${(1.4).toFixed(2)}, -legSwing);
else if (bone == 5.0) swing(transformed, ${(1.4).toFixed(2)}, legSwing);`;

/** The instance's colours for the parts that take them, each times its own shade. */
const CROWD_TINT = `#include <color_vertex>
{
  float r = fract(facade) * 8.0;
  if (r > ${(TINT_ROLE.shirt - 0.5).toFixed(1)} && r < ${(TINT_ROLE.shirt + 0.5).toFixed(1)}) vColor.rgb *= shirt;
  else if (r > ${(TINT_ROLE.shorts - 0.5).toFixed(1)} && r < ${(TINT_ROLE.shorts + 0.5).toFixed(1)}) vColor.rgb *= unpack(look.x);
  else if (r > ${(TINT_ROLE.skin - 0.5).toFixed(1)} && r < ${(TINT_ROLE.skin + 0.5).toFixed(1)}) vColor.rgb *= unpack(look.y);
  else if (r > ${(TINT_ROLE.hair - 0.5).toFixed(1)} && r < ${(TINT_ROLE.hair + 0.5).toFixed(1)}) vColor.rgb *= unpack(look.z);
}`;

function withCrowd(shader: WebGLProgramParametersWithUniforms, ink: { value: number }): void {
  shader.uniforms.inkExtra = ink;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', CROWD_VERTEX_HEAD)
    .replace('#include <begin_vertex>', CROWD_BEGIN);
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>\nvarying float vMotionFade;\nvarying float vPart;\n${DITHER}`,
    )
    .replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>\nif (${DITHERED}) discard;`,
    );
}

/** Everyone in a crowd in one draw call: the same toon, per instance, through the same shadow. */
export function createCrowdMaterial(
  gradientMap: Texture,
  ink: { value: number },
): MeshToonMaterial {
  const material = new MeshToonMaterial({ vertexColors: true, gradientMap });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = linearVertexColors(shader.vertexShader);
    withCrowd(shader, ink);
    shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', CROWD_TINT);
    // The blob under the feet is a checkerboard of its own, as the rigs' is.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>\nif (vPart == 0.0 && ${CHECKER}) discard;`,
    );
  };
  material.customProgramCacheKey = () => 'crowd-figure-v1';
  return material;
}

/** A crowd's silhouettes behind a house, each in their shirt, in one more call. */
export function createCrowdXrayMaterial(ink: { value: number }): MeshBasicMaterial {
  const material = new MeshBasicMaterial(XRAY_LOOK);
  material.onBeforeCompile = (shader) => {
    withCrowd(shader, ink);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShirt;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShirt = shirt;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShirt;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\nif (vPart == 0.0) discard;`,
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.rgb = sRGBTransferEOTF(vec4(vShirt, 1.0)).rgb;',
      );
  };
  material.customProgramCacheKey = () => 'crowd-xray-v1';
  return material;
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
 * and all of it dithers away as `fade` drops: with the zoom, or as someone comes and goes.
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
 * The avatar's silhouette where a house hides it, as Diablo IV draws its hero: a flat, solid fill
 * in its shirt's coral, drawn only where something nearer already filled the depth buffer, so it
 * shows nothing in an open street and the houses themselves never change.
 *
 * Solid, not see-through: it writes no depth, so a half see-through fill blended again wherever
 * the body overlaps itself (an arm over the chest, one leg over the other) and built up into a
 * pale blob with no figure in it. It has to draw before the figure (its `renderOrder` is lower),
 * or the figure's own front would count as something nearer and the fill would lie over it.
 */
export const XRAY_LOOK: MeshBasicMaterialParameters = {
  color: WALKER.shirt,
  depthFunc: GreaterDepth,
  depthWrite: false,
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
