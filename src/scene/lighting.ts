import { gamma, linear } from '../data/colour.ts';
import { SKY_LIGHT, SUN } from './palette.ts';

/**
 * The scene's light, shared by the viewer and the rules that check the palette against it.
 * Golden hour: a cool sky fill everywhere and a warm sun that the shadow map takes away.
 */
export const LIGHT = { sky: 1.3, sun: 2.2 } as const;

/**
 * How much of its own hue a face keeps in shade. Lit only by the cool sky, every colour drifts
 * to the same blue-grey, and sand in shadow matches asphalt in sun; this pulls the shade back
 * towards the colour's own hue at the same lightness. 0 is plain light, 1 its full hue.
 */
export const SHADE_HUE = 0.7;
/** Shade is a little richer than the colour itself, as painters do it. */
export const SHADE_CHROMA = 1.3;
/** Lit-to-base lightness ratios between which the hue is restored: full shade to half lit. */
export const SHADE_RANGE = [0.35, 0.8] as const;

export const LUMA = [0.2126, 0.7152, 0.0722] as const;
const channels = (hex: number) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map(linear);
const luma = (c: readonly number[]) => c.reduce((sum, v, i) => sum + v * LUMA[i]!, 0);
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * What a flat, upward-facing patch of `albedo` looks like on screen, in sun or in shade: the
 * same sums three.js's toon shading does (Lambert, sky from above, the sun on the top step of
 * the ramp), then the shade hue from `facade-material.ts`.
 */
export function groundOnScreen(albedo: number, sunlit: boolean): number {
  const base = channels(albedo);
  const [sky, sun] = [channels(SKY_LIGHT), channels(SUN)];
  const light = base.map(
    (b, i) => (b / Math.PI) * (LIGHT.sky * sky[i]! + (sunlit ? LIGHT.sun * sun[i]! : 0)),
  );
  const ratio = luma(light) / Math.max(luma(base), 1e-4);
  const keep = SHADE_HUE * (1 - smoothstep(SHADE_RANGE[0], SHADE_RANGE[1], ratio));
  const own = base.map((b) => b * ratio);
  const grey = luma(own);
  const out = light.map(
    (l, i) => l + (Math.max(0, grey + (own[i]! - grey) * SHADE_CHROMA) - l) * keep,
  );
  const [r, g, b] = out.map(gamma) as [number, number, number];
  return (r << 16) | (g << 8) | b;
}
