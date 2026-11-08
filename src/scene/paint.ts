import type { Marking as CityMarking, Surface } from '../data/city.ts';
import { LANE } from '../data/pitches.ts';
import type { Field } from '../data/pitches.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { PAINT } from './palette.ts';

/**
 * Road surfaces and paint tell the ground shader what they are through the `facade` attribute,
 * negated so walls keep theirs (facade-material.ts). A surface names a texture. A paint vertex also
 * says which way across its mark it lies, so the vertex shader can widen a line to a whole pixel,
 * or fold away a mark too fine to see and show its average instead: no flicker, no extra geometry.
 */
export const SURFACE = {
  plain: 0,
  asphalt: 1,
  sett: 2,
  paving: 3,
  flowers: 4,
  /** Grass with no flowers on it: gardens, verges, pitches. */
  garden: 5,
  /** The floor of woods and scrub. */
  woods: 6,
  water: 7,
  gravel: 8,
  earth: 9,
} as const;

/**
 * The texture each surface gets: joints for stone, a grain for asphalt, nothing for the rest.
 * Lawns and parks are speckled with flowers (`SURFACE.flowers`, ground.ts).
 */
export const SURFACE_OF: Record<Surface, number> = {
  asphalt: SURFACE.asphalt,
  concrete: SURFACE.paving,
  sett: SURFACE.sett,
  paving: SURFACE.paving,
  gravel: SURFACE.gravel,
  earth: SURFACE.earth,
  grass: SURFACE.garden,
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
  line: 0.06, // lane lines are painted 10–15 cm wide
  stripe: 2,
  block: 0.25,
  patch: 2,
};
/**
 * The steepest the drawn terrain gets (rise per metre; baked.test.ts holds the city to it). A
 * line widened to a pixel reaches off the triangle it was draped on, so its edges are lifted by
 * this much per metre of widening and never dip into the carriageway uphill.
 */
export const PAINT_GRADE = 0.26;
/** Metres per screen pixel above which lines go, and below which stripes replace their patch. */
export const LINE_LOD = 1.2;
export const STRIPE_LOD = 0.22;

/** Lane dashes: 3 m long as on Belgian roads; the 6 m gap is tightened so the ring reads at zoom 1. */
const DASH = 3;
const GAP = 6;
/** Zebra bars and the gaps between them, about half a metre each as in the orthophotos. */
const ZEBRA_BAR = 0.5;
/** Half the width of a cyclist crossing's red band: about 2 m across, as in the orthophotos. */
const BIKE_BAND = 1;
/** A painted cycle lane, kept equal to CYCLE_LANE in tools/build_road_zones.py. */
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
function addLine(mesh: MeshBuilder, line: Float32Array, dashed: boolean, offset = 0): void {
  const half = PAINT_HALF.line;
  let run = offset;
  segments(line, ([ax, az], _, [dx, dz, len]) => {
    const n = [-dz!, dx!] as const;
    const at = (s: number) => [ax! + dx! * s, az! + dz! * s] as const;
    if (!dashed) {
      // On past both ends, so bends need no joins once the line widens to a pixel.
      bar(mesh, 'line', at(-0.3), at(len! + 0.3), n, half, OVER, PAINT.line);
      return;
    }
    for (let s = -(run % (DASH + GAP)); s < len!; s += DASH + GAP) {
      const [start, end] = [Math.max(0, s), Math.min(len!, s + DASH)];
      if (end - start > 0.2) bar(mesh, 'line', at(start), at(end), n, half, OVER, PAINT.line);
    }
    run += len!;
  });
}

/**
 * A marking as a cell holds it: a lane line cut at a cell edge remembers how far along the whole
 * line its piece starts, so the dashes keep their rhythm across the edge.
 */
export type Marking = CityMarking & { from?: number };

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
  for (const { kind, line, from } of markings) {
    if (kind === 'dashed' || kind === 'solid') addLine(mesh, line, kind === 'dashed', from);
    else if (crossing(kind)) addCrossingBars(mesh, line, kind === 'bike-crossing');
  }
}

/** Pitch lines lie just over the pitches (ground.ts `PITCH_Y`) and under car parks and paths. */
const ON_PITCH = 0.07;
/**
 * How far a chord may stray from its arc (m): about a pixel where the lines show sharpest, so a
 * track's bend takes 16 chords and a basketball court's centre circle 7, not the same 32.
 */
const SAG = 0.2;

/** Draws a line in a field's own frame: u along its length, v across, from its centre (m). */
type Draw = (u0: number, v0: number, u1: number, v1: number) => void;

/** An arc round (cu, cv) of radius r, from angle a0 to a1 (radians from +u towards +v). */
function arc(draw: Draw, cu: number, cv: number, r: number, a0: number, a1: number): void {
  const step = 2 * Math.acos(1 - Math.min(SAG / r, 1));
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / step));
  let [pu, pv] = [cu + r * Math.cos(a0), cv + r * Math.sin(a0)];
  for (let i = 1; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const [u, v] = [cu + r * Math.cos(a), cv + r * Math.sin(a)];
    draw(pu, pv, u, v);
    [pu, pv] = [u, v];
  }
}

function box(draw: Draw, u0: number, v0: number, u1: number, v1: number): void {
  draw(u0, v0, u1, v0);
  draw(u1, v0, u1, v1);
  draw(u1, v1, u0, v1);
  draw(u0, v1, u0, v0);
}

/**
 * A soccer field, its lines a metre inside the mapped outline: touchlines, halfway line, centre
 * circle, and at each end the penalty and goal areas and the penalty arc. Their FIFA sizes hold
 * on a field 90 by 50 m or more; a smaller one scales them down with it.
 */
function soccer(draw: Draw, length: number, width: number): void {
  const [hl, hw] = [length / 2 - 1, width / 2 - 1];
  const s = Math.min(1, (hl * 2) / 90, (hw * 2) / 50);
  box(draw, -hl, -hw, hl, hw);
  draw(0, -hw, 0, hw);
  arc(draw, 0, 0, 9.15 * s, 0, 2 * Math.PI);
  // The arc of the penalty spot's circle (11 m out, 9.15 m round) outside the penalty area.
  const spot = Math.acos(5.5 / 9.15);
  for (const e of [-1, 1]) {
    for (const [depth, half] of [
      [16.5, 20.16],
      [5.5, 9.16],
    ] as const) {
      const [u, v] = [e * (hl - depth * s), half * s];
      draw(e * hl, -v, u, -v);
      draw(u, -v, u, v);
      draw(u, v, e * hl, v);
    }
    const toward = e > 0 ? Math.PI : 0;
    arc(draw, e * (hl - 11 * s), 0, 9.15 * s, toward - spot, toward + spot);
  }
}

/** Tennis courts side by side across the field, each 23.77 by 10.97 m, the singles 8.23. */
function tennis(draw: Draw, width: number, count: number): void {
  const [hl, hw, singles, service] = [11.885, 5.485, 4.115, 6.4];
  for (let k = 0; k < count; k++) {
    const v = -width / 2 + ((k + 0.5) * width) / count;
    box(draw, -hl, v - hw, hl, v + hw);
    for (const e of [-1, 1]) {
      draw(-hl, v + e * singles, hl, v + e * singles);
      draw(e * service, v - singles, e * service, v + singles);
    }
    draw(-service, v, service, v);
    draw(0, v - hw - 0.9, 0, v + hw + 0.9); // the net, out to its posts
  }
}

/**
 * A basketball court, a metre inside the outline: sidelines, halfway line and centre circle, and
 * at each end the key and the three-point line, at FIBA sizes on a court 30 by 17 m or more.
 */
function basketball(draw: Draw, length: number, width: number): void {
  const s = Math.min(1, (length - 2) / 28, (width - 2) / 15);
  const [hl, hw] = [14 * s, 7.5 * s];
  box(draw, -hl, -hw, hl, hw);
  draw(0, -hw, 0, hw);
  arc(draw, 0, 0, 1.8 * s, 0, 2 * Math.PI);
  const [r, corner] = [6.75 * s, hw - 0.9 * s];
  const a = Math.asin(corner / r);
  for (const e of [-1, 1]) {
    const [key, half] = [e * (hl - 5.8 * s), 2.45 * s];
    draw(e * hl, -half, key, -half);
    draw(key, -half, key, half);
    draw(key, half, e * hl, half);
    // The three-point line: straight from the baseline along the corners, then round the basket.
    const basket = e * (hl - 1.575 * s);
    const meet = basket - e * r * Math.cos(a);
    draw(e * hl, -corner, meet, -corner);
    draw(e * hl, corner, meet, corner);
    const toward = e > 0 ? Math.PI : 0;
    arc(draw, basket, 0, r, toward - a, toward + a);
  }
}

/** A running track's lane lines: stadiums round the infield, a lane (1.22 m) apart. */
function track(draw: Draw, length: number, width: number, lanes: number): void {
  const straight = length / 2 - width / 2;
  for (let k = 0; k <= lanes; k++) {
    const r = width / 2 + k * LANE;
    draw(-straight, -r, straight, -r);
    draw(straight, r, -straight, r);
    arc(draw, straight, 0, r, -Math.PI / 2, Math.PI / 2);
    arc(draw, -straight, 0, r, Math.PI / 2, (3 * Math.PI) / 2);
  }
}

/** A field's lines as flat [x0, z0, x1, z1, …] segments on the map. */
export function fieldLines(field: Field): number[] {
  const { x, z, angle, length, width, count } = field;
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const out: number[] = [];
  const draw: Draw = (u0, v0, u1, v1) => {
    out.push(x + u0 * cos - v0 * sin, z + u0 * sin + v0 * cos);
    out.push(x + u1 * cos - v1 * sin, z + u1 * sin + v1 * cos);
  };
  if (field.sport === 'soccer') soccer(draw, length, width);
  else if (field.sport === 'tennis') tennis(draw, width, count);
  else if (field.sport === 'basketball') basketball(draw, length, width);
  else track(draw, length, width, count);
  return out;
}

/**
 * The white lines on the pitches, drawn as lane lines are: a pixel wide at least, and only zoomed
 * in, with the fine paint. Each runs on by its half width, so corners close.
 */
export function addFieldLines(mesh: MeshBuilder, fields: readonly Field[]): void {
  const half = PAINT_HALF.line;
  for (const field of fields) {
    const lines = fieldLines(field);
    for (let i = 0; i < lines.length; i += 4) {
      const [ax, az, bx, bz] = [lines[i]!, lines[i + 1]!, lines[i + 2]!, lines[i + 3]!];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const [dx, dz] = [(bx - ax) / len, (bz - az) / len];
      const [a, b] = [
        [ax - dx * half, az - dz * half] as const,
        [bx + dx * half, bz + dz * half] as const,
      ];
      bar(mesh, 'line', a, b, [-dz, dx], half, ON_PITCH, PAINT.line);
    }
  }
}
