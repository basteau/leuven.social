import type { City } from '../data/city.ts';
import { GROUND } from '../scene/palette.ts';

/**
 * The minimap: the city round you from above, turned so that up is the way the view looks, with
 * you in the middle and everyone else as a dot in their shirt's colour. Drawn on a 2D canvas from
 * the city's own footprints (a bucket index, so a frame draws only the few hundred near you); the
 * React side (minimap-view.tsx) decides when.
 */

/** The canvas calls the minimap uses: a real 2D context has them all. */
export type Pen = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'setTransform'
  | 'translate'
  | 'rotate'
  | 'scale'
  | 'fillRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'fill'
  | 'stroke'
  | 'arc'
> & {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
};

/** Each layer, drawn in this order, and its colour. */
const LAYERS = ['green', 'water', 'roads', 'plazas', 'buildings'] as const;
type Layer = (typeof LAYERS)[number];

const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;
export const MAP_COLOURS: Record<Layer | 'ground' | 'ink' | 'outline', string> = {
  ground: css(GROUND.base),
  green: css(GROUND.green),
  water: css(GROUND.water),
  roads: css(GROUND.pavement),
  plazas: css(GROUND.plaza),
  buildings: '#9a8a76',
  ink: '#3a2e25',
  outline: 'rgb(58 46 37 / 0.55)',
};

/** The index's buckets are this many metres a side. */
const BUCKET = 100;

/** Rings by layer, each in every bucket its bounding box touches. */
export interface MinimapIndex {
  buckets: Map<number, Record<Layer, Float32Array[]>>;
}

const key = (i: number, j: number) => i * 100_000 + j;

export function indexCity(
  city: Pick<City, 'buildings' | 'green' | 'water' | 'roads' | 'plazas'>,
): MinimapIndex {
  const buckets = new Map<number, Record<Layer, Float32Array[]>>();
  const add = (layer: Layer, ring: Float32Array) => {
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < ring.length; i += 2) {
      x0 = Math.min(x0, ring[i]!);
      x1 = Math.max(x1, ring[i]!);
      z0 = Math.min(z0, ring[i + 1]!);
      z1 = Math.max(z1, ring[i + 1]!);
    }
    for (let i = Math.floor(x0 / BUCKET); i <= Math.floor(x1 / BUCKET); i++) {
      for (let j = Math.floor(z0 / BUCKET); j <= Math.floor(z1 / BUCKET); j++) {
        let bucket = buckets.get(key(i, j));
        if (!bucket) {
          bucket = { green: [], water: [], roads: [], plazas: [], buildings: [] };
          buckets.set(key(i, j), bucket);
        }
        bucket[layer].push(ring);
      }
    }
  };
  for (const ring of city.green) add('green', ring);
  for (const ring of city.water) add('water', ring);
  for (const ring of city.roads) add('roads', ring);
  for (const ring of city.plazas) add('plazas', ring);
  for (const b of city.buildings) add('buildings', b.ring);
  return { buckets };
}

/** Someone on the minimap: where they are, and their shirt (24-bit sRGB). */
export interface Dot {
  x: number;
  z: number;
  colour: number;
}

export interface MinimapView {
  /** The middle: where you are (m). */
  x: number;
  z: number;
  /** Which way the view looks, clockwise from north (radians): up on the minimap. */
  heading: number;
  /** Which way you face, as the walker's heading (0 is +z, south). */
  facing: number;
  /** How many metres across the minimap shows. */
  range: number;
  /** Its size in device pixels, square. */
  size: number;
}

/**
 * Draws the city within reach of the middle, turned to the view, then the others, then you: a
 * paper dot with an inked rim and a notch the way you face. The round frame is CSS's.
 */
export function drawMinimap(
  pen: Pen,
  index: MinimapIndex,
  view: MinimapView,
  others: readonly Dot[],
): void {
  const { size, range } = view;
  const scale = size / range;
  pen.save();
  pen.setTransform(1, 0, 0, 1, 0, 0);
  pen.fillStyle = MAP_COLOURS.ground;
  pen.fillRect(0, 0, size, size);
  // Metres east and south of you, turned so the view's way is up, onto the canvas.
  pen.translate(size / 2, size / 2);
  pen.rotate(-view.heading);
  pen.scale(scale, scale);
  pen.translate(-view.x, -view.z);
  // A half-diagonal's reach covers the square however it's turned.
  const reach = (range / 2) * Math.SQRT2;
  const [i0, i1] = [Math.floor((view.x - reach) / BUCKET), Math.floor((view.x + reach) / BUCKET)];
  const [j0, j1] = [Math.floor((view.z - reach) / BUCKET), Math.floor((view.z + reach) / BUCKET)];
  const drawn = new Set<Float32Array>();
  for (const layer of LAYERS) {
    pen.fillStyle = MAP_COLOURS[layer];
    pen.beginPath();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const ring of index.buckets.get(key(i, j))?.[layer] ?? []) {
          if (drawn.has(ring)) continue;
          drawn.add(ring);
          pen.moveTo(ring[0]!, ring[1]!);
          for (let k = 2; k < ring.length; k += 2) pen.lineTo(ring[k]!, ring[k + 1]!);
          pen.closePath();
        }
      }
    }
    pen.fill();
  }
  // The houses' ink, a hairline, as the city's outlines: the last layer's path is still open.
  const px = 1 / scale;
  pen.strokeStyle = MAP_COLOURS.outline;
  pen.lineWidth = px * (size / 200);
  pen.stroke();
  // The dots stay one size on screen, however far the map reaches.
  pen.lineWidth = 1.5 * px * (size / 160);
  pen.strokeStyle = MAP_COLOURS.ink;
  const dot = size / 40;
  for (const o of others) {
    pen.fillStyle = css(o.colour);
    pen.beginPath();
    pen.arc(o.x, o.z, dot * px, 0, Math.PI * 2);
    pen.fill();
    pen.stroke();
  }
  // You: a larger dot with a notch out the way you face.
  pen.translate(view.x, view.z);
  pen.rotate(-view.facing);
  pen.fillStyle = '#fbf6ea';
  pen.lineWidth *= 1.4;
  pen.beginPath();
  pen.moveTo(0, dot * 2.6 * px);
  pen.lineTo(dot * 1.3 * px, dot * 0.7 * px);
  pen.arc(0, 0, dot * 1.5 * px, Math.PI * 0.25, Math.PI * 0.75, true);
  pen.closePath();
  pen.fill();
  pen.stroke();
  pen.restore();
}
