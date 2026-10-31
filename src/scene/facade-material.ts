import { Color, MeshToonMaterial } from 'three';
import type { Texture } from 'three';

import { ANGLES, LINE_LOD, PAINT_HALF, PAINT_KIND, STRIPE_LOD, SURFACE } from './paint.ts';
import { WINDOW } from './palette.ts';

const f = (v: number) => v.toFixed(4);

/**
 * The one material every cell draws with: toon shading plus detail from world position.
 * - Walls (`facade` > 0 holds the wall top): windows, fading to an average wall tint when a
 *   window shrinks below a pixel instead of flickering.
 * - Road surfaces (`facade` a small negative code, paint.ts): asphalt patches, setts, paving
 *   joints, each fading out before it's finer than a pixel.
 * - Road paint (larger negative codes): the vertex shader widens a line to cover a whole pixel, or
 *   folds away a mark too fine to see and shows its average instead.
 * None of it costs a triangle.
 */
export function createFacadeMaterial(gradientMap: Texture): MeshToonMaterial {
  const material = new MeshToonMaterial({ vertexColors: true, gradientMap });
  const glass = new Color(WINDOW.glass);
  const lit = new Color(WINDOW.lit);
  const pixel = { value: 1 };
  material.userData.pixel = pixel;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlass = { value: glass };
    shader.uniforms.uLit = { value: lit };
    shader.uniforms.uPixel = pixel;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float facade;
        uniform float uPixel;
        varying float vFacade;
        varying vec3 vWorld;
        varying vec2 vWallNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float paint = -facade;
        if (paint >= ${f(ANGLES * 2)}) {
          float kind = floor(paint / ${f(ANGLES * 2)});
          float rest = paint - kind * ${f(ANGLES * 2)};
          float side = mod(rest, 2.0) * 2.0 - 1.0;
          float angle = floor(rest / 2.0) * PI / ${f(ANGLES)};
          vec2 across = vec2(cos(angle), sin(angle));
          float reach = kind == ${f(PAINT_KIND.line)} ? ${f(PAINT_HALF.line)}
            : kind == ${f(PAINT_KIND.block)} ? ${f(PAINT_HALF.block)} : ${f(PAINT_HALF.stripe)};
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
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWallNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xz + 1e-5);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uGlass;
        uniform vec3 uLit;
        varying float vFacade;
        varying vec3 vWorld;
        varying vec2 vWallNormal;
        const vec2 CELL = vec2(2.6, 3.2); // window bay width, floor height (m)
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
        '#include <color_fragment>',
        `#include <color_fragment>
        if (vFacade > 0.0) {
          vec2 p = vec2(dot(vWorld.xz, vec2(-vWallNormal.y, vWallNormal.x)), vWorld.y);
          vec2 cell = floor(p / CELL);
          vec2 f = fract(p / CELL);
          float window = step(0.28, f.x) * step(f.x, 0.72) * step(0.34, f.y) * step(f.y, 0.78);
          // Only between the ground-floor sill and just under the eaves.
          window *= step(1.0, p.y) * step(p.y, vFacade - 0.7);
          float pixel = max(fwidth(p.x), fwidth(p.y));
          float detail = 1.0 - smoothstep(0.5, 1.1, pixel);
          float coverage = mix(0.18 * step(1.0, p.y), window, detail);
          float glow = step(0.93, fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453));
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(uGlass, uLit, glow * detail), coverage * 0.8);
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
      );
  };
  material.customProgramCacheKey = () => 'facade-v2';
  return material;
}

/** World metres per screen pixel: decides how much road paint and texture the material draws. */
export function setPixelSize(material: MeshToonMaterial, metres: number): void {
  (material.userData.pixel as { value: number }).value = metres;
}
