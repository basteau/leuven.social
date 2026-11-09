import type { City } from '../data/city.ts';
import { RASTER_SCALE, simplifyRing } from '../data/map-view.ts';
import type { Frame } from '../data/map-view.ts';
import './map.css';

/**
 * The map's static layers, drawn once into one canvas (water, green, roads, building footprints,
 * simplified) and then only copied, so panning the full map never redraws 22,000 footprints. In the map's own chunk, with its styles.
 */

export interface Raster {
  canvas: HTMLCanvasElement;
  /** The city spot at its top-left corner (m). */
  minX: number;
  minZ: number;
}

/** The map's paper tones: the app's warm paper, with muted layers on it. */
const TONE = {
  ground: '#ece6d6',
  woods: '#aecb92',
  green: '#c4d9a7',
  parking: '#ddd8cb',
  railLand: '#d6d0c4',
  water: '#a8cbe3',
  plaza: '#f6ecd0',
  road: '#fffdf6',
  building: '#cdbfae',
  landmark: '#b98f6f',
  rail: '#8d867c',
} as const;

/** Footprints are thinned to this much of a corner (m): under a pixel at the closest zoom. */
const SIMPLIFY = 0.6;

function fill(
  ctx: CanvasRenderingContext2D,
  rings: Iterable<ArrayLike<number>>,
  colour: string,
  thin = 0,
): void {
  ctx.beginPath();
  for (const raw of rings) {
    const ring = thin ? simplifyRing(raw, thin) : raw;
    ctx.moveTo(ring[0]!, ring[1]!);
    for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i]!, ring[i + 1]!);
    ctx.closePath();
  }
  ctx.fillStyle = colour;
  ctx.fill('evenodd');
}

const cache = new WeakMap<City, Raster>();

/** The raster of a city, drawn the first time it is asked for (a few tens of milliseconds). */
export function rasterOf(city: City): Raster {
  const cached = cache.get(city);
  if (cached) return cached;
  const { minX, minZ, maxX, maxZ } = city.bounds;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((maxX - minX) * RASTER_SCALE);
  canvas.height = Math.ceil((maxZ - minZ) * RASTER_SCALE);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = TONE.ground;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(RASTER_SCALE, 0, 0, RASTER_SCALE, -minX * RASTER_SCALE, -minZ * RASTER_SCALE);
  fill(ctx, city.railLand, TONE.railLand);
  fill(ctx, city.parking, TONE.parking);
  fill(ctx, city.woods, TONE.woods);
  fill(ctx, city.green, TONE.green);
  fill(ctx, city.water, TONE.water);
  fill(ctx, city.plazas, TONE.plaza);
  fill(ctx, city.roads, TONE.road);
  fill(ctx, city.bridges, TONE.road);
  ctx.strokeStyle = TONE.rail;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const { line } of city.rails) {
    ctx.moveTo(line[0]!, line[1]!);
    for (let i = 2; i < line.length; i += 2) ctx.lineTo(line[i]!, line[i + 1]!);
  }
  ctx.stroke();
  const rings = (landmark: boolean) =>
    city.buildings.flatMap((b) =>
      (b.kind === 'church' || b.tier === 'hero') === landmark ? [b.ring, ...b.holes] : [],
    );
  fill(ctx, rings(false), TONE.building, SIMPLIFY);
  fill(ctx, rings(true), TONE.landmark, SIMPLIFY);
  const raster = { canvas, minX, minZ };
  cache.set(city, raster);
  return raster;
}

/**
 * Paints the raster into `ctx` as `frame` says, with the frame's middle at (`x`, `y`) on the
 * canvas, in CSS pixels. The caller has set the canvas's device transform and clip.
 */
export function paintRaster(
  ctx: CanvasRenderingContext2D,
  raster: Raster,
  frame: Frame,
  x: number,
  y: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(frame.scale, frame.scale);
  ctx.translate(-frame.cx, -frame.cz);
  ctx.translate(raster.minX, raster.minZ);
  ctx.scale(1 / RASTER_SCALE, 1 / RASTER_SCALE);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(raster.canvas, 0, 0);
  ctx.restore();
}

/** Canvas pixels per CSS pixel: sharp on dense screens, capped so the map stays cheap. */
export const dpr = (): number => Math.min(globalThis.devicePixelRatio || 1, 2);
