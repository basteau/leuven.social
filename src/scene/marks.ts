/**
 * Marks on a 2D canvas: a disc in someone's shirt with a thin ink ring, the one way a person who is
 * too small to see is drawn, on the street and on both maps. Each disc is a small image, drawn once
 * per colour and size and then only stamped, so thousands of them are cheap.
 */

import type { Marks } from './clumps.ts';

/** What of a 2D context stamping needs. */
export type MarkPen = Pick<CanvasRenderingContext2D, 'drawImage'> & { globalAlpha: number };

/** Where marks go: `screen = (a·x + c·z + e, b·x + d·z + f - lift(x, z))`, in the pen's units. */
export interface MarkFrame {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  /** How far up the screen the ground is at (x, z): its height, on a tilted view. */
  lift?(x: number, z: number): number;
}

/** The ink ring's width (CSS px). */
const RING = 1.25;
const INK = '#2b2420';
/** Radii come in half pixels and colours in 5-6-5 bits, so a crowd reuses a few sprites. */
const STEPS = 2;
/** Sprites kept, enough for any real crowd's shirts; a stranger mix starts over, and costs little. */
const MOST_SPRITES = 2048;

interface Sprite {
  canvas: HTMLCanvasElement;
  /** Half its size on screen (px). */
  half: number;
  size: number;
}

const sprites = new Map<number, Sprite>();
let spritesDpr = 0;

const reduced = (colour: number) =>
  ((colour >> 19) & 0x1f) * 0x800 + ((colour >> 10) & 0x3f) * 0x20 + ((colour >> 3) & 0x1f);

/** The 24-bit colour a reduced 5-6-5 one stands for, 5 bits repeated into the low 3 and so on. */
function expanded(rgb: number): string {
  const r = (rgb >> 11) & 0x1f;
  const g = (rgb >> 5) & 0x3f;
  const b = rgb & 0x1f;
  const whole = (((r << 3) | (r >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | (b << 3) | (b >> 2);
  return `#${whole.toString(16).padStart(6, '0')}`;
}

function spriteOf(colour: number, radius: number, dpr: number): Sprite {
  if (dpr !== spritesDpr || sprites.size >= MOST_SPRITES) {
    sprites.clear();
    spritesDpr = dpr;
  }
  const rgb = reduced(colour);
  const size = Math.round(radius * STEPS);
  const key = rgb * 64 + size;
  let sprite = sprites.get(key);
  if (sprite) return sprite;
  const r = size / STEPS;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.ceil((r + RING) * 2 * dpr);
  const half = canvas.width / (2 * dpr);
  const pen = canvas.getContext('2d')!;
  pen.scale(dpr, dpr);
  pen.beginPath();
  pen.arc(half, half, r, 0, Math.PI * 2);
  pen.fillStyle = expanded(rgb);
  pen.fill();
  pen.lineWidth = RING;
  pen.strokeStyle = INK;
  pen.stroke();
  sprite = { canvas, half, size: half * 2 };
  sprites.set(key, sprite);
  return sprite;
}

/** How many people in a crowd, as short as it can be said: 840, 1.2k, 12k. */
export function crowdLabel(n: number): string {
  if (n < 1000) return String(n);
  if (n < 9950) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

/**
 * Stamps every mark. `frame` takes ground (x, z) to where the pen draws, already in the same units
 * as the pen's transform; `dpr` is only how sharp the sprites need to be.
 */
export function drawMarks(pen: MarkPen, marks: Marks, frame: MarkFrame, dpr: number): void {
  const { count, x, z, colour, radius, alpha } = marks;
  const { a, b, c, d, e, f, lift } = frame;
  const was = pen.globalAlpha;
  for (let i = 0; i < count; i++) {
    const wx = x[i]!;
    const wz = z[i]!;
    const sprite = spriteOf(colour[i]!, radius[i]!, dpr);
    pen.globalAlpha = was * alpha[i]!;
    pen.drawImage(
      sprite.canvas,
      a * wx + c * wz + e - sprite.half,
      b * wx + d * wz + f - (lift ? lift(wx, wz) : 0) - sprite.half,
      sprite.size,
      sprite.size,
    );
  }
  pen.globalAlpha = was;
}
