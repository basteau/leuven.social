/**
 * The geometry of the enamel plates on the facades (house numbers and street names) and the
 * shops' name boards: one mesh for every plate near the walker, each a face mapped onto a shared
 * glyph atlas plus the thin sides that make it stand off its wall. Pure, so it is tested;
 * plates.ts draws the atlas and owns the three.js objects.
 *
 * A plate's face is a row of slices of the atlas, left to right: a rounded left cap, blank
 * enamel to pad it to its least width, a slice per letter, blank again, a rounded right cap. Every
 * slice carries the same rim top and bottom, so side by side they read as one plate, and no
 * texture is drawn per plate: the atlas is drawn once, from the letters the plates use.
 */

import { pointInRing } from '../data/geometry.ts';
import { HOUSE_PLATE_HEIGHT, STREET_PLATE_HEIGHT } from '../data/plates.ts';

/** Where a slice of the atlas is (0–1 texture coordinates) and how wide it is in plate heights. */
export interface Slice {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  width: number;
}

/** One style of plate (house numbers, street names): its slices in the atlas, in plate heights. */
export interface PlateStyle {
  /** Height of the plate (m). */
  height: number;
  /** Its corners' radius, in plate heights; the caps are at least this wide. */
  radius: number;
  left: Slice;
  right: Slice;
  /** Blank enamel with the rims, stretched to pad a short text. */
  blank: Slice;
  /** The narrowest the plate is, in plate heights. */
  minWidth: number;
  glyphs: ReadonlyMap<string, Slice>;
}

export interface PlateAt {
  x: number;
  y: number;
  z: number;
  /** Which way the face looks (radians from +x towards +z). */
  angle: number;
  text: string;
  style: PlateStyle;
}

/** How deep a plate is (m): its sides reach this far back, to the wall behind it. */
export const PLATE_DEPTH = 0.06;
/** Each rounded corner is drawn with this many straight pieces. */
const ARC = 3;

/** A growable set of vertex arrays, reused from one rebuild to the next. */
export class PlateBuffers {
  positions: Float32Array<ArrayBuffer> = new Float32Array(0);
  normals: Float32Array<ArrayBuffer> = new Float32Array(0);
  uvs: Float32Array<ArrayBuffer> = new Float32Array(0);
  /**
   * Linear RGB under the atlas: a name board's paint shows where its cells are clear. A plate's
   * cells are opaque, so what it carries there doesn't show.
   */
  colors: Float32Array<ArrayBuffer> = new Float32Array(0);
  indices: Uint32Array<ArrayBuffer> = new Uint32Array(0);
  vertices = 0;
  count = 0;
  /** The colour the next vertices carry. */
  tint: readonly [number, number, number] = [0, 0, 0];

  reset(): void {
    this.vertices = 0;
    this.count = 0;
  }

  /** Room for `vertices` more vertices and `indices` more indices. */
  reserve(vertices: number, indices: number): void {
    const v = this.vertices + vertices;
    if (v * 3 > this.positions.length) {
      const size = Math.max(v, this.positions.length / 3) * 2;
      this.positions = grow(this.positions, size * 3);
      this.normals = grow(this.normals, size * 3);
      this.uvs = grow(this.uvs, size * 2);
      this.colors = grow(this.colors, size * 3);
    }
    const i = this.count + indices;
    if (i > this.indices.length) {
      const next = new Uint32Array(Math.max(i, this.indices.length) * 2);
      next.set(this.indices);
      this.indices = next;
    }
  }

  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
  ): number {
    const n = this.vertices++;
    const { positions: p, normals: q, uvs: t } = this;
    p[n * 3] = x;
    p[n * 3 + 1] = y;
    p[n * 3 + 2] = z;
    q[n * 3] = nx;
    q[n * 3 + 1] = ny;
    q[n * 3 + 2] = nz;
    t[n * 2] = u;
    t[n * 2 + 1] = v;
    this.colors.set(this.tint, n * 3);
    return n;
  }

  triangle(a: number, b: number, c: number): void {
    const i = this.indices;
    i[this.count++] = a;
    i[this.count++] = b;
    i[this.count++] = c;
  }
}

function grow(array: Float32Array, length: number): Float32Array<ArrayBuffer> {
  const next = new Float32Array(length);
  next.set(array);
  return next;
}

/** How wide a plate is, in plate heights, for its text: the caps, the letters, the padding. */
export function plateWidth(text: string, style: PlateStyle): number {
  let letters = 0;
  for (const ch of text) letters += style.glyphs.get(ch)?.width ?? 0;
  return Math.max(style.minWidth, style.left.width + letters + style.right.width);
}

/**
 * The text a name board `width` metres wide shows, and how tall the board is: as tall as `high`
 * while the name fits, shorter (down to `low`) for a long one, and below that the name is cut
 * further, ending in an ellipsis. Null when not even one letter fits.
 */
export function fitBoard(
  text: string,
  style: PlateStyle,
  width: number,
  low: number,
  high: number,
): { text: string; height: number } | null {
  let chars = [...text];
  for (;;) {
    const shown = chars.join('');
    const height = Math.min(high, width / plateWidth(shown, { ...style, minWidth: 0 }));
    if (height >= low) return { text: shown, height };
    const kept = chars.at(-1) === ELLIPSIS ? chars.slice(0, -2) : chars.slice(0, -1);
    while (kept.at(-1) === ' ') kept.pop();
    if (kept.length === 0) return null;
    chars = [...kept, ELLIPSIS];
  }
}
const ELLIPSIS = '…';

/**
 * An sRGB colour as linear light, and a channel back: colour.ts's `linear` and `gamma`, kept
 * here so this chunk takes nothing more from the palette's, which every first visit loads.
 */
export const linearRgb = (hex: number): [number, number, number] =>
  [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((c) => {
    const u = c / 255;
    return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
const toByte = (u: number) =>
  Math.round(255 * Math.min(1, u <= 0.0031308 ? u * 12.92 : 1.055 * u ** (1 / 2.4) - 0.055));

/** WCAG's relative luminance of an sRGB colour. */
const luminance = (hex: number) => {
  const [r, g, b] = linearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG's contrast ratio between two sRGB colours, 1 to 21. */
export function contrast(a: number, b: number): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * A name board's paint: the darker of its kind's canvas and stripe (`FRONTS`), deepened by
 * lightness alone (its linear light scaled, so its hue stays) until `paper` letters on it reach
 * 4.5:1. A dark canvas stays as it is.
 */
export function boardColour(front: { canvas: number; stripe?: number }, paper: number): number {
  const { canvas, stripe = canvas } = front;
  const base = luminance(stripe) < luminance(canvas) ? stripe : canvas;
  // 4.6, so rounding to whole channels keeps it over 4.5.
  const k = Math.min(1, ((luminance(paper) + 0.05) / 4.6 - 0.05) / luminance(base));
  const [r, g, b] = linearRgb(base).map((u) => toByte(u * k));
  return (r! << 16) | (g! << 8) | b!;
}

/**
 * The outline of a plate in its own plane (across, up; metres from its middle), counter-clockwise
 * seen from the front: four rounded corners.
 */
export function plateOutline(width: number, height: number, radius: number): number[] {
  const [w, h] = [width / 2, height / 2];
  const r = Math.min(radius, w, h);
  const corners: [number, number, number][] = [
    [w - r, -h + r, -Math.PI / 2],
    [w - r, h - r, 0],
    [-w + r, h - r, Math.PI / 2],
    [-w + r, -h + r, Math.PI],
  ];
  const points: number[] = [];
  for (const [cx, cy, start] of corners) {
    for (let k = 0; k <= ARC; k++) {
      const a = start + (k / ARC) * (Math.PI / 2);
      points.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  }
  return points;
}

/**
 * Appends one plate: its face, slice by slice, and its sides. The face looks along its normal
 * (cos angle, 0, sin angle); "across" runs to the right as you stand in front of it.
 */
export function addPlate(out: PlateBuffers, plate: PlateAt, ink: [number, number]): void {
  const { style, text } = plate;
  const h = style.height;
  const [nx, nz] = [Math.cos(plate.angle), Math.sin(plate.angle)];
  const [rx, rz] = [nz, -nx];
  const width = plateWidth(text, style) * h;
  const { x, y, z } = plate;
  /** A vertex `s` across and `t` up from the plate's middle, `back` behind its face. */
  const put = (
    s: number,
    t: number,
    back: number,
    ex: number,
    ey: number,
    ez: number,
    u: number,
    v: number,
  ) => out.vertex(x + rx * s - nx * back, y + t, z + rz * s - nz * back, ex, ey, ez, u, v);

  // The face: caps, padding, letters, padding, caps, left to right.
  const slices: [Slice, number][] = [];
  let letters = 0;
  for (const ch of text) {
    const glyph = style.glyphs.get(ch);
    if (glyph) {
      slices.push([glyph, glyph.width * h]);
      letters += glyph.width * h;
    }
  }
  const pad = (width - (style.left.width + style.right.width) * h - letters) / 2;
  if (pad > 1e-6) {
    slices.unshift([style.blank, pad]);
    slices.push([style.blank, pad]);
  }
  const outline = plateOutline(width, h, style.radius * h);
  const corner = ARC + 1;
  // A cap is the outline's corners on its side and the straight edge where the letters begin.
  const cap = (slice: Slice, s0: number, s1: number, points: number[]) => {
    out.reserve(points.length / 2, (points.length / 2 - 2) * 3);
    const first = out.vertices;
    for (let i = 0; i < points.length; i += 2) {
      const s = points[i]!;
      const t = points[i + 1]!;
      const u = slice.u0 + ((s - s0) / (s1 - s0)) * (slice.u1 - slice.u0);
      const v = slice.v0 + ((t + h / 2) / h) * (slice.v1 - slice.v0);
      put(s, t, 0, nx, 0, nz, u, v);
    }
    for (let k = 1; k + 1 < points.length / 2; k++) out.triangle(first, first + k, first + k + 1);
  };
  const [leftEdge, rightEdge] = [
    -width / 2 + style.left.width * h,
    width / 2 - style.right.width * h,
  ];
  // Right cap: from the bottom of its straight edge round its two corners (outline order).
  cap(style.right, rightEdge, width / 2, [
    rightEdge,
    -h / 2,
    ...outline.slice(0, corner * 4),
    rightEdge,
    h / 2,
  ]);
  cap(style.left, -width / 2, leftEdge, [
    leftEdge,
    h / 2,
    ...outline.slice(corner * 4, corner * 8),
    leftEdge,
    -h / 2,
  ]);
  let s = leftEdge;
  for (const [slice, w] of slices) {
    out.reserve(4, 6);
    const a = put(s, -h / 2, 0, nx, 0, nz, slice.u0, slice.v0);
    const b = put(s + w, -h / 2, 0, nx, 0, nz, slice.u1, slice.v0);
    const c = put(s + w, h / 2, 0, nx, 0, nz, slice.u1, slice.v1);
    const d = put(s, h / 2, 0, nx, 0, nz, slice.u0, slice.v1);
    out.triangle(a, b, c);
    out.triangle(a, c, d);
    s += w;
  }

  // The sides, in the outline's ink, from the face back to the wall.
  const n = outline.length / 2;
  out.reserve(n * 4, n * 6);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const s0 = outline[i * 2]!;
    const t0 = outline[i * 2 + 1]!;
    const s1 = outline[j * 2]!;
    const t1 = outline[j * 2 + 1]!;
    const length = Math.hypot(s1 - s0, t1 - t0);
    if (length < 1e-6) continue;
    // Outward in the plate's plane: the edge turned a quarter clockwise.
    const os = (t1 - t0) / length;
    const ot = -(s1 - s0) / length;
    const [iu, iv] = ink;
    const a = put(s0, t0, 0, rx * os, ot, rz * os, iu, iv);
    const b = put(s0, t0, PLATE_DEPTH, rx * os, ot, rz * os, iu, iv);
    const c = put(s1, t1, PLATE_DEPTH, rx * os, ot, rz * os, iu, iv);
    const d = put(s1, t1, 0, rx * os, ot, rz * os, iu, iv);
    out.triangle(a, b, c);
    out.triangle(a, c, d);
  }
}

/** A cell to pack into the atlas: its width and height in texels. */
export interface Cell {
  width: number;
  height: number;
}

/**
 * Packs cells into rows of an atlas `width` texels wide, `gutter` texels apart and from the
 * edges, in order: a row ends where the next cell doesn't fit. Returns each cell's top-left
 * corner and the atlas height, rounded up to a power of two.
 */
export function packCells(
  cells: readonly Cell[],
  width: number,
  gutter: number,
): { at: [number, number][]; height: number } {
  const at: [number, number][] = [];
  let [x, y, row] = [gutter, gutter, 0];
  for (const cell of cells) {
    const w = Math.ceil(cell.width);
    if (x + w + gutter > width && x > gutter) {
      [x, y, row] = [gutter, y + row + gutter, 0];
    }
    at.push([x, y]);
    x += w + gutter;
    row = Math.max(row, cell.height);
  }
  return { at, height: 2 ** Math.ceil(Math.log2(Math.max(1, y + row + gutter))) };
}

/** Squares (m) the footprints are filed in, to find the one a plate hangs on. */
const FOOTPRINT_CELL = 32;
const cellKey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

/**
 * A building's walls as they are drawn (src/scene/buildings.ts): the rings they stand on (a
 * hipped roof's are simplified), where the house stands, its wall top above that, and which walls,
 * by their outward normal, are over a shop front.
 */
export interface Facade {
  rings: readonly ArrayLike<number>[];
  foot: number;
  top: number;
  shop(nx: number, nz: number): boolean;
}

/** The buildings' facades by their place in the list, and the ground at a point (m). */
export interface Ground {
  facade(building: number): Facade;
  height(x: number, z: number): number;
}

/** Where a plate hangs, settled onto the wall it is on. */
export interface Hang {
  x: number;
  z: number;
  /** Which way the wall faces (radians from +x towards +z). */
  angle: number;
  /** The foot of the house and the top of its walls (m). */
  foot: number;
  top: number;
  shop: boolean;
}

/** A plate's sides reach this far into its wall, so no seam opens between them. */
const TUCK = 0.01;
/** A drawn wall this far from where the bake hung a plate (m) is still its wall. */
const SNAP = 1.5;
/** ...and faces within about 40° of the way the bake said. */
const FACING = 0.75;

/**
 * Settles plates onto the walls as they are drawn: the bake hangs them on the surveyed footprint,
 * a few centimetres proud and facing a 256th of a turn, but a hipped roof's walls stand on a
 * simplified ring, and a slight turn opens a gap at the end of a long plate. The plate takes the
 * drawn wall's own facing and stands just off it, its sides tucked into it.
 */
export class Walls {
  readonly #rings: readonly ArrayLike<number>[];
  readonly #ground: Ground;
  readonly #cells = new Map<number, number[]>();

  /** `rings`: each building's surveyed footprint, to find which one a plate is on. */
  constructor(rings: readonly ArrayLike<number>[], ground: Ground) {
    this.#rings = rings;
    this.#ground = ground;
    const s = FOOTPRINT_CELL;
    for (const [b, ring] of rings.entries()) {
      let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < ring.length; i += 2) {
        [minX, maxX] = [Math.min(minX, ring[i]!), Math.max(maxX, ring[i]!)];
        [minZ, maxZ] = [Math.min(minZ, ring[i + 1]!), Math.max(maxZ, ring[i + 1]!)];
      }
      for (let i = Math.floor(minX / s); i <= Math.floor(maxX / s); i++) {
        for (let j = Math.floor(minZ / s); j <= Math.floor(maxZ / s); j++) {
          const list = this.#cells.get(cellKey(i, j));
          if (list) list.push(b);
          else this.#cells.set(cellKey(i, j), [b]);
        }
      }
    }
  }

  /**
   * Where a plate `half` metres either side of (x, z), facing `angle`, hangs: on the drawn wall
   * nearest it that faces about the same way, kept within that wall's ends where it fits. A plate
   * on no house stays where it is, over the ground at its point.
   */
  hang(x: number, z: number, angle: number, half: number): Hang {
    const [cx, cz] = [Math.cos(angle), Math.sin(angle)];
    const [px, pz] = [x - cx * 0.25, z - cz * 0.25];
    const s = FOOTPRINT_CELL;
    let building = -1;
    for (const b of this.#cells.get(cellKey(Math.floor(px / s), Math.floor(pz / s))) ?? []) {
      if (pointInRing(this.#rings[b]!, px, pz)) building = b;
    }
    // No house under it: as on a house of three storeys, over the ground at its point.
    if (building < 0) return { x, z, angle, foot: this.#ground.height(x, z), top: 9, shop: false };
    const { rings, foot, top, shop } = this.#ground.facade(building);
    let best = { d: SNAP, x, z, angle };
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i += 2) {
        const [ax, az] = [ring[i]!, ring[i + 1]!];
        const [ex, ez] = [ring[(i + 2) % n]! - ax, ring[(i + 3) % n]! - az];
        const length = Math.hypot(ex, ez);
        if (length < 1e-3) continue;
        const [ux, uz] = [ex / length, ez / length];
        // Out of the building, for counter-clockwise rings (and clockwise courtyards).
        const [nx, nz] = [uz, -ux];
        if (nx * cx + nz * cz < FACING) continue;
        const along = (x - ax) * ux + (z - az) * uz;
        const t = Math.min(length, Math.max(0, along));
        const d = Math.hypot(ax + ux * t - x, az + uz * t - z);
        if (d >= best.d) continue;
        const kept = length >= 2 * half ? Math.min(length - half, Math.max(half, along)) : t;
        const out = PLATE_DEPTH - TUCK;
        best = {
          d,
          x: ax + ux * kept + nx * out,
          z: az + uz * kept + nz * out,
          angle: Math.atan2(nz, nx),
        };
      }
    }
    const a = best.angle;
    return { x: best.x, z: best.z, angle: a, foot, top, shop: shop(Math.cos(a), Math.sin(a)) };
  }
}

/** Space (m) between a plate and the openings or plate below it. */
const GAP = 0.08;
/**
 * How far a shop's awning reaches out from its wall (m), as storefronts.ts draws it: a name board
 * on it hangs just in front of its valance.
 */
export const AWNING_REACH = 1;

/**
 * How high plates hang above a house's foot (their middles, m), in the band the facade shader
 * leaves bare between the ground floor's openings and the first floor's sills
 * (facade-material.ts): a house number just over the doors and windows (over the awning on a
 * shop front, where storefronts.ts hangs it), the way many Leuven numbers sit on the lintel, and a
 * street name above it. So no plate covers a window, whatever the rhythm of its house. Both stay
 * under the eaves. A shop's name board is lower: on its fascia, the band the shader paints in its
 * kind's canvas between the shop window and the ground floor's ceiling, or on the middle of its
 * awning's valance (storefronts.ts), which hangs the same at every front.
 */
export function plateHeights(
  top: number,
  shop: boolean,
): { house: number; street: number; fascia: number; valance: number } {
  const storey = Math.min(4, Math.max(2.8, top / Math.max(1, Math.floor(top / 3.2 + 0.5))));
  // An awning's top, where it meets the wall: its valance hangs 0.4 m lower, 0.2 m deep.
  const awning = Math.max(0.97 * storey, 3.2);
  const lintel = shop ? awning : 0.8 * storey;
  const sill = Math.min(1.32 * storey, top);
  const [h, s] = [HOUSE_PLATE_HEIGHT / 2, STREET_PLATE_HEIGHT / 2];
  const under = (half: number) => top - 0.25 - half;
  const house = Math.min(lintel + GAP + h, under(h));
  const street = Math.min(Math.max((lintel + sill) / 2, house + h + GAP + s), under(s));
  return { house, street, fascia: 0.85 * storey, valance: awning - 0.5 };
}
