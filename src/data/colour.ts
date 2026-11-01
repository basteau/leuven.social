/**
 * sRGB hex colours to and from Oklab, the perceptual space colour rules compare in: equal steps
 * in it look equally different, and its a/b axes split hue (red-green, yellow-blue) from lightness.
 */

export type Lab = [l: number, a: number, b: number];

/** An sRGB channel (0–255) as linear light (0–1). */
export const linear = (c: number) => {
  const u = c / 255;
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
};
/** Linear light (0–1) back to an sRGB channel (0–255), clipped. */
export const gamma = (u: number) => {
  const c = u <= 0.0031308 ? u * 12.92 : 1.055 * Math.max(u, 0) ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

export function toOklab(hex: number): Lab {
  const [r, g, b] = [linear((hex >> 16) & 255), linear((hex >> 8) & 255), linear(hex & 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Back to an sRGB hex colour, clipped to the gamut. */
export function fromOklab([L, a, b]: Lab): number {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bl = gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return (r << 16) | (g << 8) | bl;
}

/** Perceptual distance between two colours (ΔE in Oklab; ~0.02 is just noticeable). */
export function deltaE(x: number, y: number): number {
  const [p, q] = [toOklab(x), toOklab(y)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
