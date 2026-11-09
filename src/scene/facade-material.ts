import {
  Color,
  DoubleSide,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshToonMaterial,
  Vector4,
} from 'three';
import type { Texture, Vector3 } from 'three';

import { SHOP_KINDS } from '../data/shop-kinds.ts';
import { AWNING, CROWN, ROOF, ROOF_FLAT, PANE, WALL_PLAIN } from './facade-codes.ts';
import { LUMA, SHADE_CHROMA, SHADE_HUE, SHADE_RANGE, WATER_SUN } from './lighting.ts';
import { LIFT_UNIT, linearVertexColors } from './mesh-builder.ts';
import {
  ANGLES,
  LINE_LOD,
  PAINT_GRADE,
  PAINT_HALF,
  PAINT_KIND,
  STRIPE_LOD,
  SURFACE,
} from './paint.ts';
import { FRONTS, OUTLINE, WINDOW } from './palette.ts';
import { SLEEPER_CODE } from './rails.ts';
import { GROUND as GROUND_SURFACE } from './shader/ground-surface.ts';
import { BAYER, NOISE, f } from './shader/glsl.ts';
import { LAMP_FRAGMENT, LAMP_UNIFORMS, lampLight, withLamps } from './shader/lamp-light.ts';
import type { LampLight } from './shader/lamp-light.ts';
import { ROOF_SURFACES } from './shader/roof-surface.ts';
import { WALL } from './shader/wall-surface.ts';

export { BAYER };
export { lampLight, setLightField } from './shader/lamp-light.ts';
export type { LampLight } from './shader/lamp-light.ts';

/** How much of the ground the darkest contact shadow covers, in pixels of its dither. */
const CONTACT_DARK = 0.26;

/**
 * Which surface a fragment is, from its `facade` code (the table is facade-codes.ts and SURFACE in
 * paint.ts): each is a function of its own in shader/. To add a surface, give it a code, a function
 * and a line here. An awning's canvas is striped across in its kind's second colour.
 */
const SURFACES = `${ROOF_SURFACES}
${WALL}
${GROUND_SURFACE}
void awningSurface(inout vec3 albedo) {
  vec3 second = uFront[int(vFacade - ${f(AWNING - 0.5)}) * 2 + 1].rgb;
  float along = dot(vWorld.xz, vec2(-vWallNormal.y, vWallNormal.x)) / 0.9;
  float band = mix(0.5, step(0.5, fract(along)), 1.0 - smoothstep(0.2, 0.35, fwidth(along)));
  albedo = mix(albedo, second, band);
}
void surface(inout vec3 albedo, vec3 base, inout vec3 glowEmit) {
  if (vFacade > ${f(PANE - 0.5)}) paneSurface(albedo, glowEmit);
  else if (vFacade > ${f(WALL_PLAIN - 0.5)}) plainWall(albedo, base);
  else if (vFacade > ${f(ROOF_FLAT - 0.5)}) flatRoof(albedo);
  else if (vFacade > ${f(ROOF - 0.5)}) pitchedRoof(albedo, base);
  else if (vFacade > ${f(AWNING - 0.5)}) awningSurface(albedo);
  else if (vFacade > 0.0) wallSurface(albedo, base, glowEmit);
  else if (vFacade < ${f(-SLEEPER_CODE + 0.5)}) sleeperBand(albedo);
  else if (vFacade < -0.5 && vFacade > ${f(-SURFACE.earth - 0.5)}) groundSurface(albedo);
}`;

/**
 * The one material every cell draws with: toon shading plus detail from world position.
 * - Walls (`facade` > 0 holds the wall top, plus a code for a church or a shop front's kind,
 *   facade-codes.ts): windows in each building's own rhythm, or a church's tall pointed lancets,
 *   fading to an average wall tint when a window shrinks below two pixels instead of aliasing
 *   into stripes. A shop front glazes the ground floor under its kind's canvas (`FRONTS`).
 * - Awnings (storefronts.ts): striped in their kind's second colour.
 * - Road surfaces (`facade` a small negative code, paint.ts): asphalt patches, setts, paving
 *   joints, each fading out before it's finer than a pixel.
 * - Road paint (larger negative codes): the vertex shader widens a line to cover a whole pixel, or
 *   folds away a mark too fine to see and shows its average instead.
 * - Railway sleepers (codes from `SLEEPER_CODE`, rails.ts): a band of them along each track, from
 *   the distance along it, fading to their average tint when they get finer than a pixel.
 * - Shade everywhere keeps a richer version of its surface's own hue (lighting.ts).
 * None of it costs a triangle.
 */
export function createFacadeMaterial(
  gradientMap: Texture,
  light: LampLight = lampLight(),
): MeshToonMaterial {
  // Faces sit a hair behind their ink lines, so outlines draw solid instead of dashed.
  const material = new MeshToonMaterial({
    vertexColors: true,
    gradientMap,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const glass = new Color(WINDOW.glass);
  const lit = new Color(WINDOW.lit);
  const pixel = { value: 1 };
  material.userData.pixel = pixel;
  const night = { value: 0 };
  material.userData.night = night;
  // Each kind of shop front as two vec4s: its canvas and whether its panes are warm, its stripe
  // and whether it shows goods.
  const fronts = SHOP_KINDS.flatMap((kind) => {
    const { canvas, stripe = canvas, lit: warm, goods } = FRONTS[kind];
    const [a, b] = [new Color(canvas), new Color(stripe)];
    return [new Vector4(a.r, a.g, a.b, warm ? 1 : 0), new Vector4(b.r, b.g, b.b, goods ? 1 : 0)];
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlass = { value: glass };
    shader.uniforms.uLit = { value: lit };
    shader.uniforms.uFront = { value: fronts };
    shader.uniforms.uPixel = pixel;
    shader.uniforms.uNight = night;
    withLamps(shader.uniforms, light);
    shader.vertexShader = linearVertexColors(shader.vertexShader)
      .replace(
        '#include <common>',
        `#include <common>
        attribute float facade;
        attribute float lift;
        attribute float bay;
        uniform float uPixel;
        varying float vFacade;
        varying float vLift;
        varying float vBay;
        varying float vJoin;
        varying vec3 vWorld;
        varying vec2 vWallNormal;
        varying float vUp;`,
      )
      // A crown only casts the shadow and catches the tap, so it folds to nothing here; the puffs
      // of leaves draw the tree. A lane line is widened to a pixel by the screen size of a metre
      // across it, measured square to it on screen.
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        if (facade > ${f(CROWN - 0.5)} && facade < ${f(WALL_PLAIN - 0.5)}) transformed = vec3(0.0);
        float paint = -facade;
        if (paint >= ${f(ANGLES * 2)} && paint < ${f(SLEEPER_CODE)}) {
          float kind = floor(paint / ${f(ANGLES * 2)});
          float rest = paint - kind * ${f(ANGLES * 2)};
          float side = mod(rest, 2.0) * 2.0 - 1.0;
          float angle = floor(rest / 2.0) * PI / ${f(ANGLES)};
          vec2 across = vec2(cos(angle), sin(angle));
          float reach = kind == ${f(PAINT_KIND.line)} ? ${f(PAINT_HALF.line)}
            : kind == ${f(PAINT_KIND.block)} ? ${f(PAINT_HALF.block)}
            : kind == ${f(PAINT_KIND.patch)} ? ${f(PAINT_HALF.patch)} : ${f(PAINT_HALF.stripe)};
          float want = reach;
          if (kind == ${f(PAINT_KIND.line)}) {
            vec2 a = (modelViewMatrix * vec4(across.x, 0.0, across.y, 0.0)).xy;
            vec2 t = (modelViewMatrix * vec4(-across.y, 0.0, across.x, 0.0)).xy;
            float scale = abs(t.x * a.y - t.y * a.x) / max(length(t), 1e-4);
            want = uPixel > ${f(LINE_LOD)} ? 0.0 : max(reach, 0.5 * uPixel / max(scale, 0.2));
          } else if (kind == ${f(PAINT_KIND.patch)}) {
            want = uPixel > ${f(STRIPE_LOD)} ? reach : 0.0;
          } else {
            want = uPixel > ${f(STRIPE_LOD)} ? 0.0 : reach;
          }
          transformed.xz += across * side * (want - reach);
          transformed.y += max(want - reach, 0.0) * ${f(PAINT_GRADE)};
        }`,
      )
      // A wall corner's byte is 2 · its bay number + whether it starts a join (facade-bays.ts).
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vFacade = facade;
        vLift = lift * ${f(LIFT_UNIT)};
        vBay = floor(bay / 2.0);
        vJoin = bay - 2.0 * vBay;
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWallNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xz + 1e-5);
        vUp = (modelMatrix * vec4(objectNormal, 0.0)).y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uGlass;
        uniform vec3 uLit;
        uniform float uNight;
        ${LAMP_UNIFORMS}
        uniform vec4 uFront[${fronts.length}];
        varying float vFacade;
        varying float vLift;
        varying float vBay;
        varying float vJoin;
        varying vec3 vWorld;
        varying vec2 vWallNormal;
        varying float vUp;
        ${BAYER}
        ${NOISE}
        ${SURFACES}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 glowEmit = vec3(0.0);
        surface(diffuseColor.rgb, vColor.rgb, glowEmit);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        // Lit windows and shop fronts glow at night whatever the light on them.
        `#include <emissivemap_fragment>\ntotalEmissiveRadiance += glowEmit;\n${LAMP_FRAGMENT}`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
        if (abs(vFacade + ${f(SURFACE.water)}) < 0.5) {
          reflectedLight.directDiffuse = mix(reflectedLight.directDiffuse,
            getGradientIrradiance(geometryNormal, directionalLights[0].direction) *
            directionalLights[0].color * BRDF_Lambert(material.diffuseColor), ${f(WATER_SUN)});
        }
        #endif`,
      )
      // Shade keeps a richer version of its own hue at the same lightness (lighting.ts), so sand
      // in shadow stays sand instead of matching asphalt in the sun.
      .replace(
        '#include <opaque_fragment>',
        `vec3 luma = vec3(${LUMA.map(f).join(', ')});
        float shadeRatio = dot(outgoingLight, luma) / max(dot(diffuseColor.rgb, luma), 1e-4);
        vec3 own = diffuseColor.rgb * shadeRatio;
        vec3 rich = max(vec3(dot(own, luma)) + (own - dot(own, luma)) * ${f(SHADE_CHROMA)}, 0.0);
        float keep = ${f(SHADE_HUE)} * (1.0 - smoothstep(${f(SHADE_RANGE[0])}, ${f(SHADE_RANGE[1])}, shadeRatio));
        outgoingLight = mix(outgoingLight, rich, keep);
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => 'facade-v16';
  return material;
}

/**
 * What stands on the ground darkens the ground beside it, in the ordered dither (contact.ts): the
 * foot of a wall, a rack. Each vertex's `facade` is how dark, 1 at the wall and 0 where it ends.
 */
export function createContactMaterial(cell: { value: number }): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ color: OUTLINE });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDitherCell = cell;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float facade;\nvarying float vDark;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDark = facade;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float uDitherCell;\nvarying float vDark;\n${BAYER}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\nif (bayer4(gl_FragCoord.xy / uDitherCell) >= vDark * ${f(CONTACT_DARK)}) discard;`,
      );
  };
  material.customProgramCacheKey = () => 'contact-v2';
  return material;
}

/**
 * Leaves up close: a tree's crown as puffs (`addPuffs` in trees.ts), one quad each, turned to the
 * camera in the vertex shader. In the fragment shader each is a ball of blocky clumps of leaves:
 * a ragged rim, its normal from the ball, so the toon ramp shades it in round steps, and its depth
 * too, so the puffs of a crown cut into each other as balls do. Lit and shadowed as the rest.
 */
export function createPuffMaterial(
  gradientMap: Texture,
  light: LampLight,
  pixel: { value: number },
  depthPerMetre: number,
  sunward: { value: Vector3 },
): MeshToonMaterial {
  // A depth pass draws the back faces of what's shadowed; a puff is one flat face.
  const material = new MeshToonMaterial({
    vertexColors: true,
    gradientMap,
    shadowSide: DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPixel = pixel;
    shader.uniforms.uSunward = sunward;
    withLamps(shader.uniforms, light);
    shader.vertexShader = linearVertexColors(shader.vertexShader)
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 puff;
        uniform float uPixel;
        uniform vec3 uSunward;
        varying vec2 vPuff;
        varying vec3 vWorld;
        varying float vRadius;
        varying float vLeaf;
        varying float vSeed;`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = puff.xyz
          + vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * position.x * puff.w
          + vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) * position.y * puff.w;
        vPuff = position.xy;
        vWorld = transformed;
        vRadius = puff.w;
        vLeaf = min(0.7, max(0.18, uPixel * 2.6) / puff.w);
        vSeed = fract(puff.x * 3.17 + puff.z * 7.31);`,
      )
      // A tree's puffs cast its shadow and would each shade the next: look up the shadow from
      // outside the crown, on the sun's side, so it only feels what's cast from elsewhere.
      .replace(
        '#include <shadowmap_vertex>',
        `worldPosition.xyz += uSunward * puff.w * 3.2;\n#include <shadowmap_vertex>`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vPuff;
        varying vec3 vWorld;
        varying float vRadius;
        varying float vLeaf;
        varying float vSeed;
        ${LAMP_UNIFORMS}
        ${BAYER}
        ${NOISE}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        vec2 leaf = (floor(vPuff / vLeaf) + 0.5) * vLeaf;
        float grain = hash2(leaf * 41.0 + vSeed * 13.0);
        float rim = length(leaf);
        if (rim > 1.0 - 0.24 * grain) discard;
        vec3 ball = vec3(leaf + (grain - 0.5) * 0.26, 0.0);
        ball.z = sqrt(max(0.05, 1.0 - dot(ball.xy, ball.xy)));
        gl_FragDepth = gl_FragCoord.z - ball.z * vRadius * ${depthPerMetre.toFixed(9)};`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= 0.86 + 0.3 * grain;`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        'vec3 normal = normalize(ball);\nvec3 nonPerturbedNormal = normal;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\n${LAMP_FRAGMENT}`,
      );
  };
  material.customProgramCacheKey = () => 'puff-v2';
  return material;
}

/**
 * The shadow of a puff of leaves: the same quad turned to the sun (the shadow camera's own view
 * matrix) and cut to a disc, so a tree's shadow is the round of its leaves.
 */
export function createPuffDepthMaterial(): MeshDepthMaterial {
  const material = new MeshDepthMaterial();
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 puff;\nvarying vec2 vPuff;')
      .replace(
        '#include <begin_vertex>',
        // modelViewMatrix, as three doesn't hand a depth material the view matrix; the mesh itself
        // stands at the origin, so the two are the same.
        `vec3 transformed = puff.xyz
          + vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]) * position.x * puff.w
          + vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]) * position.y * puff.w;
        vPuff = position.xy;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPuff;')
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\nif (dot(vPuff, vPuff) > 0.8) discard;',
      );
  };
  material.customProgramCacheKey = () => 'puff-depth-v1';
  return material;
}

/** World metres per screen pixel: decides how much road paint and texture the material draws. */
export function setPixelSize(material: MeshToonMaterial, metres: number): void {
  (material.userData.pixel as { value: number }).value = metres;
}

/** How far into the night it is, 0 (day) to 1: how many windows and shop fronts are lit. */
export function setNight(material: MeshToonMaterial, night: number): void {
  (material.userData.night as { value: number }).value = night;
}

/**
 * The lanterns lit at night (`addLampGlow`): unlit, in their own colour, drawn only where a 4×4
 * ordered dither lets them through, by each vertex's `facade` (1 on a lantern) times how far into
 * the night it is. No blending, no sorting: they fade in the same pixel pattern as everything
 * else here.
 */
export function createGlowMaterial(lamps: { value: number }): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = lamps;
    shader.vertexShader = linearVertexColors(shader.vertexShader)
      .replace(
        '#include <common>',
        '#include <common>\nattribute float facade;\nvarying float vGlow;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = facade;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float uNight;\nvarying float vGlow;\n${BAYER}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\nif (bayer4(gl_FragCoord.xy) >= vGlow * uNight) discard;',
      );
  };
  material.customProgramCacheKey = () => 'glow-v1';
  return material;
}
