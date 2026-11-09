import type { City } from '../data/city.ts';
import type { People } from '../net/people.ts';
import { createClumper } from '../scene/clumps.ts';
import type { Marks } from '../scene/clumps.ts';
import { drawMarks } from '../scene/marks.ts';
import { GROUND, ROUTE } from '../scene/palette.ts';
import { YOU, css } from './colours.ts';

/**
 * The minimap: the city round you from above, turned so that up is the way the view looks, with
 * you in the middle and everyone else as the street's marks, a dot each or a disc for a crowd.
 * Drawn on a 2D canvas from the city's own footprints (a bucket index, so a frame draws only the
 * few hundred near you); the React side (minimap-view.tsx) decides when.
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
  | 'drawImage'
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
  globalAlpha: number;
};

/** Each layer, drawn in this order, and its colour. */
const LAYERS = ['green', 'water', 'roads', 'plazas', 'buildings'] as const;
type Layer = (typeof LAYERS)[number];

export const MAP_COLOURS: Record<Layer | 'ground' | 'ink' | 'outline' | 'paper', string> = {
  ground: css(GROUND.base),
  green: css(GROUND.green),
  water: css(GROUND.water),
  roads: css(GROUND.pavement),
  plazas: css(GROUND.plaza),
  buildings: '#9a8a76',
  ink: '#3a2e25',
  outline: 'rgb(58 46 37 / 0.55)',
  paper: '#fffdf6',
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

export interface MinimapView {
  /** Where the walk you set off on ends (m), if you're on one. */
  target?: readonly [number, number] | null;
  /** The middle: where you are (m). */
  x: number;
  z: number;
  /** Which way the view looks, clockwise from north (radians): up on the minimap. */
  heading: number;
  /** Which way you face, as the walker's heading (0 is +z, south). */
  facing: number;
  /** How many metres across the minimap shows. */
  range: number;
  /** Its size in device pixels, square, and how many of those a CSS pixel is. */
  size: number;
  dpr: number;
}

/** The cell the minimap's marks are grouped by covers this many pixels: mid octave, so no crossfade. */
const CELL_PX = 24;
/** The biggest a crowd gets, or a few crowds fill the whole little window (CSS px). */
const LARGEST_CLUMP = 9;
/** The grid's coarsest step of 5 m to this power of two. */
const cellLevel = (pxPerMetre: number) => Math.round(Math.log2(CELL_PX / (5 * pxPerMetre)));
/** A scale at which the clumper picks the level above and doesn't sit fading between two. */
const settledScale = (pxPerMetre: number) => CELL_PX / (5 * 2 ** cellLevel(pxPerMetre));

/** No one to draw: before a connection, or with no others on it. */
export const NOBODY: Marks = {
  count: 0,
  x: new Float32Array(0),
  z: new Float32Array(0),
  n: new Uint32Array(0),
  colour: new Int32Array(0),
  radius: new Float32Array(0),
  alpha: new Float32Array(0),
  settling: false,
};

/**
 * Everyone inside the minimap's circle, ready to draw at its scale. A closure keeps the arrays
 * and each clump's easing from one repaint to the next.
 */
export function createMinimapCrowd(clock?: () => number) {
  const clumper = createClumper(clock);
  let inside = new Float32Array(64);
  return (people: People, view: MinimapView): Marks => {
    if (inside.length < people.count) inside = new Float32Array(people.count * 2);
    const { x: px, z: pz } = people;
    const radius = view.range / 2;
    const reach = radius * radius;
    for (let s = 0; s < people.count; s++) {
      const dx = px[s]! - view.x;
      const dz = pz[s]! - view.z;
      inside[s] = dx * dx + dz * dz <= reach ? 1 : 0;
    }
    return clumper.clump(people, {
      pxPerMetre: settledScale(view.size / view.dpr / view.range),
      x0: view.x - radius,
      z0: view.z - radius,
      x1: view.x + radius,
      z1: view.z + radius,
      place: '',
      floor: 0,
      alpha: inside,
      largest: LARGEST_CLUMP,
    });
  };
}

/** The city drawn once round a spot, north up, for the minimap to turn and move under you. */
export interface CityImage {
  image: CanvasImageSource;
  /** Its middle (m) and how many metres a side it covers. */
  x: number;
  z: number;
  span: number;
}

/** Whether a city image drawn for `range` still covers the minimap round (x, z), turned any way. */
export const covers = (city: CityImage | null, x: number, z: number, range: number) =>
  city !== null &&
  city.span === range * 2 &&
  // The minimap's corners reach range/2·√2 from its middle; the image, `range` from its own.
  Math.hypot(x - city.x, z - city.z) <= range * (1 - Math.SQRT1_2);

/**
 * The city's footprints, squares, water and parks within `span` metres round (x, z), north up,
 * inked as the city is, filling a `size`-pixel square: drawn once, and again only as you leave it.
 */
export function drawCity(
  pen: Pen,
  index: MinimapIndex,
  x: number,
  z: number,
  span: number,
  size: number,
): void {
  const scale = size / span;
  pen.save();
  pen.setTransform(1, 0, 0, 1, 0, 0);
  pen.fillStyle = MAP_COLOURS.ground;
  pen.fillRect(0, 0, size, size);
  pen.translate(size / 2, size / 2);
  pen.scale(scale, scale);
  pen.translate(-x, -z);
  const half = span / 2;
  const [i0, i1] = [Math.floor((x - half) / BUCKET), Math.floor((x + half) / BUCKET)];
  const [j0, j1] = [Math.floor((z - half) / BUCKET), Math.floor((z + half) / BUCKET)];
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
  pen.strokeStyle = MAP_COLOURS.outline;
  pen.lineWidth = 1 / scale;
  pen.stroke();
  pen.restore();
}

/** The radius of the mark for the end of a walk, and what it keeps clear of the rim (CSS px). */
const END_RADIUS = 4.5;
const END_CLEAR = 4;
/** How much of the minimap's foot the Map tab covers (CSS px). */
const TAB_COVERS = 27;

/**
 * Where the end of a walk at (x, y) from the middle of a minimap `width` across goes: at its spot
 * within the rim, else on the rim in its direction, which says the way to go, and above the Map
 * tab, which would hide it.
 */
export function routeEnd(x: number, y: number, width: number): readonly [number, number] {
  const rim = width / 2 - END_RADIUS - END_CLEAR;
  const held = Math.min(1, rim / Math.hypot(x, y));
  return [x * held, Math.min(y * held, width / 2 - TAB_COVERS - END_RADIUS)];
}

function drawRouteEnd(pen: Pen, x: number, y: number, middle: number, width: number): void {
  const [ex, ey] = routeEnd(x, y, width);
  // The target on the street, small: ink, paper and the accent.
  for (const [radius, colour] of [
    [END_RADIUS + 1.5, MAP_COLOURS.ink],
    [END_RADIUS, MAP_COLOURS.paper],
    [END_RADIUS * 0.55, css(ROUTE.goal)],
  ] as const) {
    pen.fillStyle = colour;
    pen.beginPath();
    pen.arc(middle + ex, middle + ey, radius, 0, Math.PI * 2);
    pen.fill();
  }
}

/**
 * The minimap for a frame: the city image turned so the view's way is up and moved so you are in
 * the middle, then the marks of everyone round you, then you, the coral diamond with its long
 * point the way you face. The round frame is CSS's.
 */
export function drawMinimap(pen: Pen, city: CityImage, view: MinimapView, marks: Marks): void {
  const { size, range, dpr } = view;
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
  const half = city.span / 2;
  pen.drawImage(city.image, city.x - half, city.z - half, city.span, city.span);
  pen.restore();

  // The marks and you are in CSS pixels, the same size however far the map reaches.
  pen.save();
  pen.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = size / dpr;
  const middle = width / 2;
  const toPx = width / range;
  const cos = Math.cos(view.heading) * toPx;
  const sin = Math.sin(view.heading) * toPx;
  drawMarks(
    pen,
    marks,
    {
      a: cos,
      b: -sin,
      c: sin,
      d: cos,
      e: middle - cos * view.x - sin * view.z,
      f: middle + sin * view.x - cos * view.z,
    },
    dpr,
  );
  if (view.target) {
    const [tx, tz] = [view.target[0] - view.x, view.target[1] - view.z];
    drawRouteEnd(pen, cos * tx + sin * tz, cos * tz - sin * tx, middle, width);
  }
  // You on top of every crowd: the diamond over your head on the street, its long point the way
  // you face, with a rim of paper so it stands clear of whatever shirts are round it.
  const dot = (width / 40) * 1.25;
  pen.translate(middle, middle);
  pen.rotate(-view.heading);
  pen.rotate(-view.facing);
  pen.fillStyle = YOU;
  pen.beginPath();
  pen.moveTo(0, dot * 2.7);
  pen.lineTo(dot * 1.4, 0);
  pen.lineTo(0, dot * -1.4);
  pen.lineTo(dot * -1.4, 0);
  pen.closePath();
  pen.strokeStyle = MAP_COLOURS.paper;
  pen.lineWidth = (width / 160) * 4;
  pen.stroke();
  pen.fill();
  pen.strokeStyle = MAP_COLOURS.ink;
  pen.lineWidth = (width / 160) * 2;
  pen.stroke();
  pen.restore();
}
