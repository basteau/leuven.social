/** Small shapes the full map and the minimap share, in the app's ink and accent. */

import { loadWaypoints } from '../data/waypoints.ts';
import type { Waypoint } from '../data/waypoints.ts';
import type { Store } from './store.ts';

const loaded = new WeakSet<Store<Waypoint[]>>();
/** Fills the marks store from localStorage the first time a map part needs it. */
export function ensureMarks(store: Store<Waypoint[]>): void {
  if (loaded.has(store)) return;
  loaded.add(store);
  store.set(loadWaypoints());
}

/** The accent (`--accent` in index.html) as the canvas needs it. */
export const ACCENT = '#1d5c9b';
const OTHER = '#8d867c';

/** A waypoint: a coloured dot in a white ring. */
export function drawMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  colour: string,
  r: number,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.3);
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

/** Where a route ends: a ring in the accent with a dot in it. */
export function drawTarget(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, r * 0.3);
  ctx.strokeStyle = ACCENT;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = ACCENT;
  ctx.fill();
}

/** A player: an arrowhead pointing `angle` radians clockwise from up; the own one in the accent. */
export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  r: number,
  self: boolean,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.3);
  ctx.lineTo(r * 0.95, r);
  ctx.lineTo(0, r * 0.45);
  ctx.lineTo(-r * 0.95, r);
  ctx.closePath();
  ctx.fillStyle = self ? ACCENT : OTHER;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.3);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.restore();
}
