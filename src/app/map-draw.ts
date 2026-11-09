/** The small shapes the full map draws, in the app's ink and accent. */

import { YOU, YOU_DEEP, YOU_LIT } from './colours.ts';

/** The accent (`--accent` in index.html) as the canvas needs it. */
export const ACCENT = '#1d5c9b';
/** The ink of what's drawn on the map: names and a spot just picked. */
export const INK = '#2b2420';
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

/** A building you can go into: its door, a paper arch on an accent disc. */
export function drawDoor(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, 9, 0, Math.PI * 2);
  ctx.fillStyle = ACCENT;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-3.5, 5);
  ctx.lineTo(-3.5, -1);
  ctx.arc(0, -1, 3.5, Math.PI, 0);
  ctx.lineTo(3.5, 5);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
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

/**
 * A player: the diamond that marks you on the street, its long point `angle` radians clockwise from
 * up, the way they face. Others flat in their colour, you cut in facets in your coral.
 */
export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  r: number,
  self: boolean,
): void {
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.9);
    ctx.lineTo(r, 0);
    ctx.lineTo(0, r);
    ctx.lineTo(-r, 0);
    ctx.closePath();
  };
  const facet = (fill: string, side: number, along: number) => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(side * r, 0);
    ctx.lineTo(0, along);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  trace();
  ctx.fillStyle = self ? YOU : OTHER;
  ctx.fill();
  if (self) {
    facet(YOU_LIT, -1, r);
    facet(YOU_DEEP, 1, -r * 1.9);
    trace();
  }
  ctx.lineWidth = Math.max(1.5, r * 0.22);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = self ? INK : '#fff';
  ctx.stroke();
  ctx.restore();
}
