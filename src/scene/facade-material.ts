import { Color, MeshToonMaterial } from 'three';
import type { Texture } from 'three';

import { WINDOW } from './palette.ts';

/**
 * The building material: toon shading plus procedural windows, drawn from world position on
 * faces whose `facade` attribute holds the wall-top height. Windows cost no geometry, and when
 * a window shrinks below a pixel they fade into an average wall tint instead of flickering.
 * A negative `facade` is minus the distance along a railway track: the same trick draws its
 * sleepers, with the ballast showing between them.
 */
export function createFacadeMaterial(gradientMap: Texture): MeshToonMaterial {
  const material = new MeshToonMaterial({ vertexColors: true, gradientMap });
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
        const vec2 CELL = vec2(2.6, 3.2); // window bay width, floor height (m)
        // Sleepers: one per metre, wider apart than the real 0.6 m so a standard screen still
        // resolves them at the closest zoom.
        const float SLEEPER_PITCH = 1.0;`,
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
        } else if (vFacade < 0.0) {
          float along = -vFacade / SLEEPER_PITCH;
          float detail = 1.0 - smoothstep(0.25, 0.4, fwidth(along));
          float sleeper = mix(0.5, step(fract(along), 0.5), detail);
          diffuseColor.rgb *= mix(0.84, 1.0, sleeper);
        }`,
      );
  };
  material.customProgramCacheKey = () => 'facade-v2';
  return material;
}
