import { Color, MeshToonMaterial } from 'three';
import type { Texture } from 'three';

import { LUMA, SHADE_CHROMA, SHADE_HUE, SHADE_RANGE } from './lighting.ts';
import { SHOP_FRONT } from './buildings.ts';
import { AWNINGS, WINDOW } from './palette.ts';

const f = (v: number) => v.toFixed(4);
/** A palette colour as a GLSL vec3 in linear light, the space the shader works in. */
const vec = (hex: number) => {
  const c = new Color(hex);
  return `vec3(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`;
};

/**
 * The building material: toon shading plus procedural windows, drawn from world position on
 * faces whose `facade` attribute holds the wall-top height. Windows cost no geometry, and when
 * a window shrinks below two pixels they fade into an average wall tint instead of flickering.
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

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlass = { value: glass };
    shader.uniforms.uLit = { value: lit };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float facade;
        varying float vFacade;
        varying vec3 vWorld;
        varying vec2 vWallNormal;`,
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
        `,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (vFacade > 0.0) {
          // Walls carry their top height, plus SHOP_FRONT on buildings with a shop front.
          float shop = step(${f(SHOP_FRONT / 2)}, vFacade);
          float top = vFacade - shop * ${f(SHOP_FRONT)};
          // Each building's own rhythm, seeded by its wall height: bay width, window width,
          // and as many storeys as fit, so the top row always sits under the eaves.
          float seed = fract(sin(top * 91.345) * 43758.5453);
          float seed2 = fract(seed * 13.17 + 0.37);
          float storey = clamp(top / max(1.0, floor(top / 3.2 + 0.5)), 2.8, 4.0);
          vec2 size = vec2(mix(2.2, 3.4, seed), storey);
          float halfWidth = mix(0.17, 0.25, seed2);
          vec2 p = vec2(dot(vWorld.xz, vec2(-vWallNormal.y, vWallNormal.x)), vWorld.y);
          vec2 cell = floor(p / size);
          vec2 g = fract(p / size);
          float window = step(0.5 - halfWidth, g.x) * step(g.x, 0.5 + halfWidth) * step(0.32, g.y) * step(g.y, 0.8);
          // Only between the ground-floor sill and just under the eaves.
          window *= step(1.0, p.y) * step(p.y, top - 0.7);
          float average = 2.0 * halfWidth * 0.48 * step(1.0, p.y);
          vec3 glass = uGlass;
          // A shop front: one wide pane per bay on the ground floor, under an awning in the
          // shop's colour.
          float ground = shop * (1.0 - step(storey, p.y));
          float awning = ground * step(storey * 0.78, p.y) * step(p.y, storey * 0.92);
          float pane = step(0.08, g.x) * step(g.x, 0.92) * step(0.1, p.y) * step(p.y, storey * 0.72);
          window = mix(window, pane, ground);
          average = mix(average, 0.6, ground);
          float pick = fract(sin(dot(cell + 0.5, vec2(4.898, 7.23))) * 23421.631);
          vec3 canvas = ${AWNINGS.map((c, i) => `pick < ${f((i + 1) / AWNINGS.length)} ? ${vec(c)} : `).join('')}vec3(0.0);
          // A window narrower than about two device pixels aliases into stripes, so the grid
          // fades to its average tint between three and two pixels per window.
          float pixel = max(fwidth(p.x), fwidth(p.y));
          float span = 2.0 * halfWidth * size.x;
          float detail = 1.0 - smoothstep(span / 3.0, span / 2.0, pixel);
          float coverage = mix(average, window, detail);
          float glow = step(0.93, fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453)) * (1.0 - ground);
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(glass, uLit, glow * detail), coverage * 0.8);
          diffuseColor.rgb = mix(diffuseColor.rgb, canvas, awning * (1.0 - smoothstep(0.3, 0.6, pixel)));
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
  material.customProgramCacheKey = () => 'facade-v1-shade';
  return material;
}
