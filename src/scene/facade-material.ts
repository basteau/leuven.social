import { Color, MeshToonMaterial, Vector4 } from 'three';
import type { LineBasicMaterial, Material, Texture } from 'three';

import { SHOP_KINDS } from '../data/shop-kinds.ts';
import { LANCETS, SHOP_FRONT } from './facade-codes.ts';
import { LUMA, SHADE_CHROMA, SHADE_HUE, SHADE_RANGE } from './lighting.ts';
import { LIFT_UNIT, linearVertexColors } from './mesh-builder.ts';
import { ANGLES, LINE_LOD, PAINT_HALF, PAINT_KIND, STRIPE_LOD, SURFACE } from './paint.ts';
import { FRONTS, WINDOW } from './palette.ts';
import { SLEEPER_CODE } from './rails.ts';

const f = (v: number) => v.toFixed(4);
/** A 4×4 ordered dither: a threshold from 0 to 15/16 for each pixel of a block. */
export const BAYER = `float bayer2(vec2 a) { a = mod(floor(a), 2.0); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }`;

/**
 * How near the walking camera (m) the city dithers away; 0 on the map, where nothing does. One
 * uniform for the city's materials, set by walk mode.
 */
export const nearFade = { value: 0 };
/**
 * The ground round the walking camera, as y = a + b · x + c · z, for the street
 * the dither spares. Set by walk mode with `nearFade`.
 */
export const nearGround = { value: [0, 0, 0] };

const NEAR_FADE = `uniform float uNearFade;
uniform vec3 uNearGround;
float overGround(vec3 w) { return w.y - dot(uNearGround, vec3(1.0, w.xz)); }
${BAYER}`;

/**
 * Drops the fragment at `world` in a dither the nearer it is to the camera, from `nearFade` in
 * to about half that, where all of it is gone: whatever the walking camera backs into (a
 * facade, a trunk, a crown, a lamp post) opens up rather than filling the screen, and a house
 * it stands in shows none of its insides. Still no blending or sorting. `keep` spares the
 * street underfoot.
 */
const nearDiscard = (world: string, keep: string) =>
  `if (uNearFade > 0.0 && !(${keep}) &&
    bayer4(gl_FragCoord.xy) >= smoothstep(0.45 * uNearFade, uNearFade, distance(${world}, cameraPosition))) discard;`;

/**
 * A plain three.js material dithers away near the walking camera like the city's walls, all but
 * what `keep` spares (GLSL on `vNearWorld`, the fragment's world position).
 */
export function fadeNearCamera(material: Material, key: string, keep = 'false'): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNearFade = nearFade;
    shader.uniforms.uNearGround = nearGround;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNearWorld;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvNearWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vNearWorld;\n${NEAR_FADE}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\n${nearDiscard('vNearWorld', keep)}`,
      );
  };
  material.customProgramCacheKey = () => key;
}

/** The city's ink lines dither away near the walking camera too, all but those on the ground. */
export function fadeInkNearCamera(ink: LineBasicMaterial): void {
  fadeNearCamera(ink, 'ink-v2', 'overGround(vNearWorld) < 0.45');
}

/**
 * The one material every cell draws with: toon shading plus detail from world position.
 * - Walls (`facade` > 0 holds the wall top, plus a code for a church or a shop front's kind,
 *   facade-codes.ts): windows in each building's own rhythm, or a church's tall pointed lancets,
 *   fading to an average wall tint when a window shrinks below two pixels instead of aliasing
 *   into stripes. A shop front glazes the ground floor under its kind's canvas (`FRONTS`).
 * - Road surfaces (`facade` a small negative code, paint.ts): asphalt patches, setts, paving
 *   joints, each fading out before it's finer than a pixel.
 * - Road paint (larger negative codes): the vertex shader widens a line to cover a whole pixel, or
 *   folds away a mark too fine to see and shows its average instead.
 * - Railway sleepers (codes from `SLEEPER_CODE`, rails.ts): a band of them along each track, from
 *   the distance along it, fading to their average tint when they get finer than a pixel.
 * - Shade everywhere keeps a richer version of its surface's own hue (lighting.ts).
 * - While walking, whatever stands within a couple of metres of the camera dithers away
 *   (`nearFade`), all but the street.
 * None of it costs a triangle.
 */
export function createFacadeMaterial(gradientMap: Texture): MeshToonMaterial {
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
    shader.uniforms.uNearFade = nearFade;
    shader.uniforms.uNearGround = nearGround;
    shader.vertexShader = linearVertexColors(shader.vertexShader)
      .replace(
        '#include <common>',
        `#include <common>
        attribute float facade;
        attribute float lift;
        uniform float uPixel;
        varying float vFacade;
        varying float vLift;
        varying vec3 vWorld;
        varying vec2 vWallNormal;
        varying float vUp;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
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
            // Screen size of a metre across the line, measured square to it on screen.
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
        }`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vFacade = facade;
        vLift = lift * ${f(LIFT_UNIT)};
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
        uniform vec4 uFront[${fronts.length}];
        varying float vFacade;
        varying float vLift;
        varying vec3 vWorld;
        varying vec2 vWallNormal;
        varying float vUp;
        ${NEAR_FADE}
        // Sleepers: one per metre, wider apart than the real 0.6 m so a standard screen still
        // resolves them at the closest zoom.
        const float SLEEPER_PITCH = 1.0;
        float hash2(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 u = fract(p);
          u = u * u * (3.0 - 2.0 * u);
          return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x),
                     mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
        }`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        ${nearDiscard('vWorld', 'vUp > 0.5 && overGround(vWorld) < 0.45')}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (vFacade > 0.0) {
          // Walls carry their top height, plus LANCETS on churches or SHOP_FRONT + 100 · kind over
          // a shop front (facade-codes.ts).
          float shop = step(${f(SHOP_FRONT - 0.5)}, vFacade);
          float church = step(${f(LANCETS - 0.5)}, vFacade) - shop;
          float kind = shop * floor((vFacade - ${f(SHOP_FRONT)}) / 100.0);
          float top = vFacade - church * ${f(LANCETS)} - shop * (${f(SHOP_FRONT)} + 100.0 * kind);
          // Each building's own rhythm, seeded by its wall height: bay width, window width,
          // and as many storeys as fit, so the top row always sits under the eaves.
          float seed = fract(sin(top * 91.345) * 43758.5453);
          float seed2 = fract(seed * 13.17 + 0.37);
          float storey = clamp(top / max(1.0, floor(top / 3.2 + 0.5)), 2.8, 4.0);
          // A church: a lancet 1.5 m wide every 5.5 m.
          vec2 size = vec2(mix(mix(2.2, 3.4, seed), 5.5, church), storey);
          float halfWidth = mix(mix(0.17, 0.25, seed2), 0.75 / 5.5, church);
          // Storeys count from the foot of the house, wherever the ground lifted it.
          vec2 p = vec2(dot(vWorld.xz, vec2(-vWallNormal.y, vWallNormal.x)), vWorld.y - vLift);
          vec2 cell = floor(p / size);
          vec2 g = fract(p / size);
          float window = step(0.5 - halfWidth, g.x) * step(g.x, 0.5 + halfWidth) * step(0.32, g.y) * step(g.y, 0.8);
          // Only between the ground-floor sill and just under the eaves.
          window *= step(1.0, p.y) * step(p.y, top - 0.7);
          float average = 2.0 * halfWidth * 0.48 * step(1.0, p.y);
          // Lancets from 3 m to 2 m under the eaves, narrowing to a point over their last 1.6 m.
          float apex = top - 2.0;
          float lancet = step(3.0, p.y) * step(p.y, apex) *
            step(abs(g.x - 0.5) * size.x, 0.75 * sqrt(clamp((apex - p.y) / 1.6, 0.0, 1.0)));
          window = mix(window, lancet, church);
          average = mix(average, 2.0 * halfWidth * step(3.0, p.y) * step(p.y, apex), church);
          vec3 glass = uGlass;
          // A shop front: one wide pane per bay on the ground floor, under its kind's canvas.
          float ground = shop * (1.0 - step(storey, p.y));
          float awning = ground * step(storey * 0.78, p.y) * step(p.y, storey * 0.92);
          float pane = step(0.08, g.x) * step(g.x, 0.92) * step(0.1, p.y) * step(p.y, storey * 0.72);
          window = mix(window, pane, ground);
          average = mix(average, 0.6, ground);
          // A window narrower than about two device pixels aliases into stripes, so the grid
          // fades to its average tint between three and two pixels per window.
          float pixel = max(fwidth(p.x), fwidth(p.y));
          vec4 front = uFront[int(kind) * 2];
          vec4 second = uFront[int(kind) * 2 + 1];
          // Stripes 45 cm wide, blended to their average once finer than a couple of pixels.
          float band = mix(0.5, step(0.5, fract(p.x / 0.9)), 1.0 - smoothstep(0.2, 0.35, pixel));
          vec3 canvas = mix(front.rgb, second.rgb, band);
          // Warm panes in a café, goods in a shop's window: blocks of its canvas and paper.
          glass = mix(glass, mix(glass, uLit, 0.55), ground * front.w);
          float item = hash2(floor(vec2(p.x / 0.32, p.y / 0.28)));
          float goods = ground * second.w * step(0.15, p.y) * step(p.y, storey * 0.3) * step(0.45, item);
          glass = mix(glass, mix(front.rgb, vec3(0.93, 0.89, 0.8), item), goods);
          float span = 2.0 * halfWidth * size.x;
          float detail = 1.0 - smoothstep(span / 3.0, span / 2.0, pixel);
          float coverage = mix(average, window, detail);
          float glow = step(0.93, fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453)) * (1.0 - ground - church);
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(glass, uLit, glow * detail), coverage * 0.8);
          diffuseColor.rgb = mix(diffuseColor.rgb, canvas, awning * (1.0 - smoothstep(0.3, 0.6, pixel)));
        } else if (vFacade < ${f(-SLEEPER_CODE + 0.5)}) {
          float along = (-vFacade - ${f(SLEEPER_CODE)}) / SLEEPER_PITCH;
          float detail = 1.0 - smoothstep(0.25, 0.4, fwidth(along));
          float sleeper = mix(0.5, step(fract(along), 0.5), detail);
          diffuseColor.rgb *= mix(0.84, 1.0, sleeper);
        } else if (vFacade < -0.5 && vFacade > ${f(-SURFACE.paving - 0.5)}) {
          float surface = floor(0.5 - vFacade);
          vec2 p = vWorld.xz;
          float pixel = max(fwidth(p.x), fwidth(p.y));
          // Patches of newer and older surface, with hard edges like the rest of the scene.
          float wear = noise2(p / 9.0) + 0.35 * noise2(p / 2.3);
          float shade = 1.0 + 0.045 * (step(0.98, wear) - step(wear, 0.5));
          if (surface == ${f(SURFACE.sett)}) {
            // Setts in staggered rows: each stone a little lighter or darker once it spans a
            // pixel and a half, and joints, at least a pixel wide, once it spans four.
            vec2 size = vec2(0.6, 0.45);
            vec2 q = p / size;
            q.x += 0.5 * mod(floor(q.y), 2.0);
            vec2 g = fract(q);
            vec2 width = max(vec2(0.12), pixel / size);
            float joint = 1.0 - step(width.x, g.x) * step(width.y, g.y);
            float stone = hash2(floor(q));
            shade = 1.0 + 0.08 * (step(0.67, stone) - step(stone, 0.33)) * (1.0 - smoothstep(0.3, 0.45, pixel))
              - 0.15 * joint * (1.0 - smoothstep(0.11, 0.15, pixel));
          } else if (surface == ${f(SURFACE.paving)}) {
            // Square slabs, each its own tone, with joints at least a pixel wide once a slab
            // spans eight.
            vec2 g = fract(p / 1.2);
            float width = max(0.04, pixel / 1.2);
            float joint = 1.0 - step(width, g.x) * step(width, g.y);
            shade = 1.0 + 0.03 * (hash2(floor(p / 1.2)) - 0.5) * (1.0 - smoothstep(0.3, 0.6, pixel))
              - 0.07 * joint * (1.0 - smoothstep(0.1, 0.15, pixel));
          }
          diffuseColor.rgb *= shade;
        }`,
      )
      .replace(
        '#include <opaque_fragment>',
        `// Shade keeps a richer version of its own hue at the same lightness (lighting.ts), so
        // sand in shadow stays sand instead of matching asphalt in the sun.
        vec3 luma = vec3(${LUMA.map(f).join(', ')});
        float shadeRatio = dot(outgoingLight, luma) / max(dot(diffuseColor.rgb, luma), 1e-4);
        vec3 own = diffuseColor.rgb * shadeRatio;
        vec3 rich = max(vec3(dot(own, luma)) + (own - dot(own, luma)) * ${f(SHADE_CHROMA)}, 0.0);
        float keep = ${f(SHADE_HUE)} * (1.0 - smoothstep(${f(SHADE_RANGE[0])}, ${f(SHADE_RANGE[1])}, shadeRatio));
        outgoingLight = mix(outgoingLight, rich, keep);
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => 'facade-v7';
  return material;
}

/** World metres per screen pixel: decides how much road paint and texture the material draws. */
export function setPixelSize(material: MeshToonMaterial, metres: number): void {
  (material.userData.pixel as { value: number }).value = metres;
}
