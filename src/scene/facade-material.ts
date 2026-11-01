import { Color, MeshToonMaterial } from 'three';
import type { Texture } from 'three';

import { LUMA, SHADE_CHROMA, SHADE_HUE, SHADE_RANGE } from './lighting.ts';
import { WINDOW } from './palette.ts';

const f = (v: number) => v.toFixed(4);

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
        const vec2 CELL = vec2(2.6, 3.2); // window bay width, floor height (m)`,
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
          // A window narrower than about two device pixels aliases into stripes, so the grid
          // fades to its average tint between three and two pixels per window.
          float pixel = max(fwidth(p.x), fwidth(p.y));
          float detail = 1.0 - smoothstep(0.38, 0.57, pixel);
          float coverage = mix(0.18 * step(1.0, p.y), window, detail);
          float glow = step(0.93, fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453));
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(uGlass, uLit, glow * detail), coverage * 0.8);
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
