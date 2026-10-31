import type { CarriagewayKind, Marking } from '../data/city.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { PAINT } from './palette.ts';

/**
 * Road surfaces and paint tell the ground shader what they are through the `facade` attribute,
 * negated so walls keep theirs (facade-material.ts). A surface names a texture. A paint vertex also
 * says which way across its mark it lies, so the vertex shader can widen a line to a whole pixel,
 * or fold away a mark too fine to see and show its average instead: no flicker, no extra geometry.
 */
export const SURFACE = { plain: 0, asphalt: 1, sett: 2, paving: 3 } as const;

export const SURFACE_OF: Record<CarriagewayKind, number> = {
  cycleway: SURFACE.asphalt,
  street: SURFACE.asphalt,
  main: SURFACE.asphalt,
  sett: SURFACE.sett,
  paving: SURFACE.paving,
};

/**
 * Paint kinds. A line grows to at least a pixel and goes when a pixel is wider than `LINE_LOD`;
 * stripes and blocks show only below `STRIPE_LOD`, and a patch (their average) only above it.
 */
export const PAINT_KIND = { line: 1, stripe: 2, block: 3, patch: 4 } as const;
type PaintKind = keyof typeof PAINT_KIND;
/** Directions are stored in 512ths of half a turn, with a bit for the side of the mark. */
export const ANGLES = 512;
/** How far each kind reaches either side of its middle, across its stored direction (m). */
export const PAINT_HALF: Record<PaintKind, number> = {
  line: 0.06,
  stripe: 2,
  block: 0.25,
  patch: 2,
};
/** Metres per screen pixel above which lines go, and below which stripes replace their patch. */
export const LINE_LOD = 1.5;
export const STRIPE_LOD = 0.45;

const DASH = 3;
const GAP = 6;
const ZEBRA_BAR = 0.5;
const BIKE_BAND = 1;
const CYCLE_LANE = 1.5;
/** Heights above the slab: over the road surface (0.15), under the squares (0.2). */
const UNDER = 0.16;
const OVER = 0.17;
const UP: V3 = [0, 1, 0];

/** The facade value for a paint vertex: `side` is 1 on the +(nx, nz) edge of the mark, else 0. */
export function paintCode(kind: PaintKind, nx: number, nz: number, side: 0 | 1): number {
  let index = Math.round((Math.atan2(nz, nx) / Math.PI) * ANGLES);
  let s = side;
  // Directions are kept in [0, π): the opposite one is the same axis with its sides swapped.
  if (index < 0 || index >= ANGLES) {
    index = (index + ANGLES) % ANGLES;
    s = (1 - side) as 0 | 1;
  }
  return -(PAINT_KIND[kind] * ANGLES * 2 + index * 2 + s);
}

/** What the vertex shader reads back from a paint code (facade-material.ts does the same in GLSL). */
export function readPaint(facade: number): { kind: number; nx: number; nz: number; side: -1 | 1 } {
  const code = -facade;
  const kind = Math.floor(code / (ANGLES * 2));
  const rest = code - kind * ANGLES * 2;
  const angle = (Math.floor(rest / 2) / ANGLES) * Math.PI;
  return { kind, nx: Math.cos(angle), nz: Math.sin(angle), side: rest % 2 ? 1 : -1 };
}

/**
 * A rectangle from a to b, `half` either side: paint of one kind folding across (nx, nz), or a
 * plain surface code that's always shown.
 */
function bar(
  mesh: MeshBuilder,
  kind: PaintKind | number,
  [ax, az]: readonly [number, number],
  [bx, bz]: readonly [number, number],
  [nx, nz]: readonly [number, number],
  half: number,
  y: number,
  color: number,
): void {
  const lo = typeof kind === 'number' ? kind : paintCode(kind, nx, nz, 0);
  const hi = typeof kind === 'number' ? kind : paintCode(kind, nx, nz, 1);
  const [ox, oz] = [nx * half, nz * half];
  mesh.quad(
    [ax - ox, y, az - oz],
    [bx - ox, y, bz - oz],
    [bx + ox, y, bz + oz],
    [ax + ox, y, az + oz],
    color,
    UP,
    [lo, lo, hi, hi],
  );
}

function segments(line: Float32Array, visit: (a: number[], b: number[], d: number[]) => void) {
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    const len = Math.hypot(bx - ax, bz - az);
    if (len > 1e-6) visit([ax, az], [bx, bz], [(bx - ax) / len, (bz - az) / len, len]);
  }
}

/** Lane lines, dashed along the whole line rather than per segment, so bends keep the rhythm. */
function addLine(mesh: MeshBuilder, line: Float32Array, dashed: boolean): void {
  const half = PAINT_HALF.line;
  let run = 0;
  segments(line, ([ax, az], _, [dx, dz, len]) => {
    const n = [-dz!, dx!] as const;
    const at = (s: number) => [ax! + dx! * s, az! + dz! * s] as const;
    if (!dashed) {
      // On past both ends, so bends need no joins once the line widens to a pixel.
      bar(mesh, 'line', at(-0.3), at(len! + 0.3), n, half, OVER, PAINT.line);
      return;
    }
    for (let s = -(run % (DASH + GAP)); s < len!; s += DASH + GAP) {
      const [from, to] = [Math.max(0, s), Math.min(len!, s + DASH)];
      if (to - from > 0.2) bar(mesh, 'line', at(from), at(to), n, half, OVER, PAINT.line);
    }
    run += len!;
  });
}

/** Where a crossing runs, and the frame across and along the road at its start. */
function crossingFrame(line: Float32Array) {
  const [ax, az] = [line[0]!, line[1]!];
  const [bx, bz] = [line[line.length - 2]!, line[line.length - 1]!];
  const len = Math.hypot(bx - ax, bz - az);
  const [dx, dz] = len > 0 ? [(bx - ax) / len, (bz - az) / len] : [1, 0];
  const road = [-dz, dx] as const; // the direction traffic runs, along the zebra's bars
  const at = (s: number, t = 0) => [ax + dx * s + road[0] * t, az + dz * s + road[1] * t] as const;
  return { len, road, at };
}

/**
 * What a crossing looks like from afar: a zebra's average grey, or the red band of a Belgian
 * cyclist crossing.
 */
function addCrossing(mesh: MeshBuilder, line: Float32Array, bike: boolean): void {
  const { len, road, at } = crossingFrame(line);
  if (len < 1) return;
  if (bike) bar(mesh, -SURFACE.asphalt, at(0), at(len), road, BIKE_BAND, UNDER, PAINT.bike);
  else bar(mesh, 'patch', at(0), at(len), road, PAINT_HALF.patch, UNDER, PAINT.patch);
}

/**
 * Its paint up close: zebra bars half a metre wide and apart across the road, or two rows of
 * blocks along the edges of the cycle band.
 */
function addCrossingBars(mesh: MeshBuilder, line: Float32Array, bike: boolean): void {
  const { len, road, at } = crossingFrame(line);
  if (len < 1) return;
  if (bike) {
    for (const t of [-BIKE_BAND, BIKE_BAND]) {
      for (let s = 0.25; s + ZEBRA_BAR <= len; s += 2 * ZEBRA_BAR) {
        bar(
          mesh,
          'block',
          at(s, t),
          at(s + ZEBRA_BAR, t),
          road,
          PAINT_HALF.block,
          OVER,
          PAINT.line,
        );
      }
    }
    return;
  }
  const bars = Math.floor((len + ZEBRA_BAR) / (2 * ZEBRA_BAR));
  const start = (len - (bars * 2 - 1) * ZEBRA_BAR) / 2;
  for (let i = 0; i < bars; i++) {
    const s = start + i * 2 * ZEBRA_BAR;
    bar(mesh, 'stripe', at(s), at(s + ZEBRA_BAR), road, PAINT_HALF.stripe, OVER, PAINT.line);
  }
}

/** A painted cycle lane: a red ribbon running on past its ends, like the paths. */
function addCycleLane(mesh: MeshBuilder, line: Float32Array): void {
  const half = CYCLE_LANE / 2;
  segments(line, ([ax, az], _, [dx, dz, len]) => {
    const at = (s: number) => [ax! + dx! * s, az! + dz! * s] as const;
    bar(mesh, -SURFACE.asphalt, at(-half), at(len! + half), [-dz!, dx!], half, UNDER, PAINT.bike);
  });
}

const crossing = (kind: Marking['kind']) => kind === 'zebra' || kind === 'bike-crossing';

/** The paint that shows at every zoom: cycle lanes, and crossings as their average colour. */
export function addPaint(mesh: MeshBuilder, markings: readonly Marking[]): void {
  for (const { kind, line } of markings) {
    if (kind === 'cycle-lane') addCycleLane(mesh, line);
    else if (crossing(kind)) addCrossing(mesh, line, kind === 'bike-crossing');
  }
}

/**
 * The paint that only shows zoomed in: lane lines, zebra bars and the blocks of cycle crossings.
 * The viewer draws it last, so it can leave it out whole when a pixel is wider than `LINE_LOD`.
 */
export function addFinePaint(mesh: MeshBuilder, markings: readonly Marking[]): void {
  for (const { kind, line } of markings) {
    if (kind === 'dashed' || kind === 'solid') addLine(mesh, line, kind === 'dashed');
    else if (crossing(kind)) addCrossingBars(mesh, line, kind === 'bike-crossing');
  }
}
