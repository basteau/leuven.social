/**
 * The geometry of the enamel plates on the facades (house numbers and street names): one mesh
 * for every plate near the walker, each a face mapped onto a shared glyph atlas plus the thin
 * sides that make it stand off its wall. Pure, so it is tested; plates.ts draws the atlas and
 * owns the three.js objects.
 *
 * A plate's face is a row of slices of the atlas, left to right: a rounded left cap, blank
 * enamel to pad it to its least width, a slice per letter, blank again, a rounded right cap. Every
 * slice carries the same rim top and bottom, so side by side they read as one plate, and no
 * texture is drawn per plate: the atlas is drawn once, from the letters the plates use.
 */

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
  indices: Uint32Array<ArrayBuffer> = new Uint32Array(0);
  vertices = 0;
  count = 0;

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
