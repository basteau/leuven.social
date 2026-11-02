import type { V3 } from './mesh-builder.ts';

/**
 * The sun's shadow map covers what's on screen rather than the whole city, so its texels stay
 * small however big the map grows. It is still static: it renders again only when the view
 * leaves the covered square or zooms in far enough to deserve sharper shadows.
 */

/** The sun's axes: `dir` points towards the sun, `right` and `up` span the shadow map. */
export interface LightFrame {
  dir: V3;
  right: V3;
  up: V3;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** The same basis three.js gives a camera at `dir` looking at the origin, with y up. */
export function lightFrame(towardsSun: V3): LightFrame {
  const dir = norm(towardsSun);
  const right = norm(cross([0, 1, 0], dir));
  return { dir, right, up: cross(dir, right) };
}

/** A square in the shadow map's plane: centre (`x`, `y`) along right and up, half size. */
export interface ShadowSquare {
  x: number;
  y: number;
  half: number;
}

/** Where the given ground points land on the shadow map plane, as a bounding square. */
export function shadowNeeds(frame: LightFrame, points: readonly V3[]): ShadowSquare {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    const [x, y] = [dot(p, frame.right), dot(p, frame.up)];
    [minX, maxX] = [Math.min(minX, x), Math.max(maxX, x)];
    [minY, maxY] = [Math.min(minY, y), Math.max(maxY, y)];
  }
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    half: Math.max(maxX - minX, maxY - minY) / 2,
  };
}

/**
 * The square to render: the need grown by `margin` for panning room, its size rounded up to a
 * quarter power of two (steps of 19%) so small zooms reuse it, and its centre snapped to whole texels so shadow edges
 * land on the same texels every time it moves.
 */
export function fitShadow(need: ShadowSquare, mapSize: number, margin = 1.3): ShadowSquare {
  const half = 2 ** (Math.ceil(4 * Math.log2(Math.max(need.half * margin, 1))) / 4);
  const texel = (2 * half) / mapSize;
  return {
    x: Math.round(need.x / texel) * texel,
    y: Math.round(need.y / texel) * texel,
    half,
  };
}

/**
 * Whether a rendered square still serves the need: covers it, and isn't over `coarser` times too
 * coarse (the viewer allows 2× from the map, so a small zoom in reuses it, and less from the street).
 */
export function shadowCovers(fit: ShadowSquare, need: ShadowSquare, coarser = 2): boolean {
  return (
    Math.abs(need.x - fit.x) + need.half <= fit.half &&
    Math.abs(need.y - fit.y) + need.half <= fit.half &&
    fit.half <= need.half * coarser
  );
}

/** World position of a point on the shadow plane, `distance` towards the sun. */
export function shadowPoint(frame: LightFrame, x: number, y: number, distance: number): V3 {
  const { right, up, dir } = frame;
  return [
    right[0] * x + up[0] * y + dir[0] * distance,
    right[1] * x + up[1] * y + dir[1] * distance,
    right[2] * x + up[2] * y + dir[2] * distance,
  ];
}

/** Distances along the sun direction spanned by the given points: the shadow camera's depth. */
export function depthRange(frame: LightFrame, points: readonly V3[]): [number, number] {
  const d = points.map((p) => dot(p, frame.dir));
  return [Math.min(...d), Math.max(...d)];
}

/** How far off its surface a shadow lookup starts, in texels, and the limits on that (m). */
const NORMAL_BIAS_TEXELS = 1.5;
const NORMAL_BIAS_RANGE = [0.08, 1.2] as const;
/** How much nearer the sun a lookup is taken than the point itself (m). */
const DEPTH_BIAS = 0.05;

/**
 * The sun shadow's biases for a fitted square, in three's units: the normal offset (m) lifts each
 * lookup about one and a half texels off its surface, which clears the filtered taps a texel
 * either side (shadow-filter.ts) however finely the square is drawn, and stays well under a bench.
 * The depth bias is a few centimetres, as a fraction of the shadow camera's `depth` (m).
 */
export function shadowBias(
  fit: ShadowSquare,
  mapSize: number,
  depth: number,
): { normalBias: number; bias: number } {
  const texel = (2 * fit.half) / mapSize;
  const [lo, hi] = NORMAL_BIAS_RANGE;
  return {
    normalBias: Math.min(hi, Math.max(lo, NORMAL_BIAS_TEXELS * texel)),
    bias: -DEPTH_BIAS / depth,
  };
}
