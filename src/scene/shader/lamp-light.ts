import { DataTexture, LinearFilter, RGBAFormat, Vector2, Vector4 } from 'three';
import type { Texture } from 'three';

import type { LightField } from '../lamp-light.ts';

/** What every material lit by the street lamps reads (`LAMP_FRAGMENT`). */
export interface LampLight {
  map: { value: Texture };
  /** The field's corner (x, z) and one over its size (m). */
  box: { value: Vector4 };
  /** The ground heights its alpha runs between (m). */
  height: { value: Vector2 };
  /** How far on the lamps are, 0 to 1. */
  on: { value: number };
  /** How many device pixels make one pixel of the dither. */
  cell: { value: number };
}

function dark(): DataTexture {
  const texture = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/** The lamps, off, over a black field, until `setLightField` has one to show. */
export function lampLight(): LampLight {
  return {
    map: { value: dark() },
    box: { value: new Vector4(0, 0, 1, 1) },
    height: { value: new Vector2() },
    on: { value: 0 },
    cell: { value: 1 },
  };
}

/** The baked light (lamp-light.ts) as a texture the shaders can sample, filtered smooth. */
export function setLightField(light: LampLight, field: LightField): void {
  const texture = new DataTexture(
    field.data as Uint8Array<ArrayBuffer>,
    field.width,
    field.height,
    RGBAFormat,
  );
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  light.map.value = texture;
  light.box.value.set(
    field.minX,
    field.minZ,
    1 / (field.width * field.texel),
    1 / (field.height * field.texel),
  );
  light.height.value.set(field.low, field.high);
}

export const LAMP_UNIFORMS = `uniform sampler2D uLightMap;
uniform vec4 uLightBox;
uniform vec2 uLightHeight;
uniform float uLamps;
uniform float uDitherCell;`;

/**
 * What the lamps add to a surface at `vWorld`, as light on its own colour rather than a sticker
 * over it, so the setts under a lamp stay setts: the field's light, gone by 7 m over the ground
 * under it (a wall's foot is lit and its eaves aren't, nor is a roof), in five steps with the
 * ordered dither between them, the pixel pattern of everything else here.
 */
export const LAMP_FRAGMENT = `if (uLamps > 0.0) {
  vec4 lampField = texture2D(uLightMap, (vWorld.xz - uLightBox.xy) * uLightBox.zw);
  float lampHigh = vWorld.y - mix(uLightHeight.x, uLightHeight.y, lampField.a);
  vec3 lampRay = lampField.rgb * (1.0 - smoothstep(1.2, 7.0, lampHigh));
  float lampMost = max(lampRay.r, max(lampRay.g, lampRay.b));
  if (lampMost > 0.004) {
    float lampStep = floor(lampMost * 5.0 + bayer4(gl_FragCoord.xy / uDitherCell)) / 5.0;
    totalEmissiveRadiance += diffuseColor.rgb * (lampRay / lampMost) * lampStep * 1.7 * uLamps;
  }
}`;

/** Hands a toon material's shader the lamps' uniforms. */
export function withLamps(uniforms: Record<string, { value: unknown }>, light: LampLight): void {
  uniforms.uLightMap = light.map;
  uniforms.uLightBox = light.box;
  uniforms.uLightHeight = light.height;
  uniforms.uLamps = light.on;
  uniforms.uDitherCell = light.cell;
}
