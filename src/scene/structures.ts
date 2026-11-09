import { ShapeUtils, Vector2 } from 'three';

import { CYCLE_LANE } from '../data/city.ts';
import type { Deck, Ramp, Tank, Tunnel } from '../data/city.ts';
import { deckEnds, deckSides } from '../data/structures.ts';
import { mitres } from '../data/terrain.ts';
import type { Terrain } from '../data/terrain.ts';
import { LAYER_Y } from './ground.ts';
import type { LineBuilder, MeshBuilder, V3 } from './mesh-builder.ts';
import { SURFACE, SURFACE_OF } from './paint.ts';
import { GROUND, STRUCTURES, SURFACE_COLOURS, carriagewayColor } from './palette.ts';

const UP: V3 = [0, 1, 0];
/** Parapets: a low wall a little over waist height, from the deck (road level) up (m). */
const PARAPET_TOP = 1.1;
const PARAPET_HALF = 0.2;
const DECK = 0.15;

/** A tank or silo: its footprint walled up to its height under a flat lid, outlined at the top. */
export function addTank(mesh: MeshBuilder, lines: LineBuilder, { height, ring }: Tank): void {
  const n = ring.length / 2;
  const contour = Array.from({ length: n }, (_, i) => new Vector2(ring[i * 2]!, ring[i * 2 + 1]!));
  for (let i = 0; i < n; i++) {
    const [a, b] = [contour[i]!, contour[(i + 1) % n]!];
    // Counter-clockwise in (x, z): the outside lies to the right of each edge.
    const out: V3 = [b.y - a.y, 0, a.x - b.x];
    mesh.quad(
      [a.x, 0, a.y],
      [b.x, 0, b.y],
      [b.x, height, b.y],
      [a.x, height, a.y],
      STRUCTURES.tank,
      out,
    );
    lines.segment([a.x, height, a.y], [b.x, height, b.y]);
  }
  const top = contour.map((p): V3 => [p.x, height, p.y]);
  mesh.polygon(top, ShapeUtils.triangulateShape(contour, []), STRUCTURES.tankTop, UP);
}

/** The capstone along a parapet's top: how far it overhangs each face, and how thick it is (m). */
const COPING_OVER = 0.06;
const COPING = 0.08;

/**
 * A bridge parapet along an open line: a low stone wall under a paler capstone that overhangs
 * it a little, outlined along the capstone's edges.
 */
export function addParapet(mesh: MeshBuilder, lines: LineBuilder, line: ArrayLike<number>): void {
  const last = line.length / 2 - 1;
  for (let i = 0; i < last; i++) {
    const [ax, az, bx, bz] = [line[i * 2]!, line[i * 2 + 1]!, line[i * 2 + 2]!, line[i * 2 + 3]!];
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 1e-6) continue;
    const [ux, uz] = [(bz - az) / length, -(bx - ax) / length];
    const corner = (x: number, z: number, side: 1 | -1, y: number, half = PARAPET_HALF): V3 => [
      x + ux * half * side,
      y,
      z + uz * half * side,
    ];
    const under = PARAPET_TOP - COPING;
    const cap = PARAPET_HALF + COPING_OVER;
    for (const side of [1, -1] as const) {
      const out: V3 = [ux * side, 0, uz * side];
      mesh.quad(
        corner(ax, az, side, DECK),
        corner(bx, bz, side, DECK),
        corner(bx, bz, side, under),
        corner(ax, az, side, under),
        STRUCTURES.parapet,
        out,
      );
      mesh.quad(
        corner(ax, az, side, under, cap),
        corner(bx, bz, side, under, cap),
        corner(bx, bz, side, PARAPET_TOP, cap),
        corner(ax, az, side, PARAPET_TOP, cap),
        STRUCTURES.coping,
        out,
      );
      lines.segment(corner(ax, az, side, PARAPET_TOP, cap), corner(bx, bz, side, PARAPET_TOP, cap));
    }
    mesh.quad(
      corner(ax, az, 1, PARAPET_TOP, cap),
      corner(bx, bz, 1, PARAPET_TOP, cap),
      corner(bx, bz, -1, PARAPET_TOP, cap),
      corner(ax, az, -1, PARAPET_TOP, cap),
      STRUCTURES.coping,
      UP,
    );
    // Its ends, where the wall meets the bank.
    for (const [x, z, sign] of [
      [ax, az, -1],
      [bx, bz, 1],
    ] as const) {
      if ((sign < 0 && i > 0) || (sign > 0 && i < last - 1)) continue;
      mesh.quad(
        corner(x, z, 1, DECK),
        corner(x, z, -1, DECK),
        corner(x, z, -1, PARAPET_TOP, cap),
        corner(x, z, 1, PARAPET_TOP, cap),
        STRUCTURES.parapet,
        [((bx - ax) / length) * sign, 0, ((bz - az) / length) * sign],
      );
    }
  }
}

/** How deep a deck's edge beam hangs under its surface (m). */
const FASCIA = 0.9;
/** How wide a pier is (m). */
const PIER = 1.1;
/** A railing or low wall along a ramp's top (m). */
const RAMP_WALL = 1.05;
/** A retaining wall stands this far above the top of a cutting (m): a kerb round the drop. */
const KERB_TOP = 0.5;

/** A ramp's wall is cut into lengths of this beside another ramp (m), to stop at its roadway. */
const WALL_PIECE = 2;
/** How far inside a roadway a wall has to be not to stand (m): what walkable.ts walks through. */
const WALL_INSIDE = 0.3;
/** Two ramps within this of each other's height are one roadway there (m). */
const WALL_STEP = 0.75;

/**
 * Whether (x, z) lies on a ramp's roadway at about the height `lift`, so a wall there holds nothing
 * back and stands in the road. Walls between a higher ramp and a lower one stay: they're the step.
 */
function sameRoadway({ line, rise, half }: Ramp, x: number, z: number, lift: number): boolean {
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    const [dx, dz] = [bx - ax, bz - az];
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(ax + dx * t - x, az + dz * t - z) > half - WALL_INSIDE) continue;
    const r = rise[i / 2]! + (rise[i / 2 + 1]! - rise[i / 2]!) * t;
    if (Math.abs(r - lift) < WALL_STEP) return true;
  }
  return false;
}

function rampBox({ line, half }: Ramp): readonly [number, number, number, number] {
  let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < line.length; i += 2) {
    [x0, z0] = [Math.min(x0, line[i]! - half), Math.min(z0, line[i + 1]! - half)];
    [x1, z1] = [Math.max(x1, line[i]! + half), Math.max(z1, line[i + 1]! + half)];
  }
  return [x0, z0, x1, z1];
}

/** Whether two ramps' boxes meet, walls and all. */
function touches(a: Ramp, b: Ramp): boolean {
  const [p, q] = [rampBox(a), rampBox(b)];
  return p[0] <= q[2] && q[0] <= p[2] && p[1] <= q[3] && q[1] <= p[3];
}

const cuttingFloor = (g: number, r: number) => g + Math.min(r, 0) + LAYER_Y.roads;

const pointAt = (ring: ArrayLike<number>, i: number): [number, number] => [
  ring[i * 2]!,
  ring[i * 2 + 1]!,
];

/** A deck's surface: its outline over its ground, and its ways as ribbons of their own. */
export function addDeckSurface(mesh: MeshBuilder, deck: Deck): void {
  const contour = Array.from(
    { length: deck.ring.length / 2 },
    (_, i) => new Vector2(...pointAt(deck.ring, i)),
  );
  const y = LAYER_Y.bridges;
  const paving = deck.carries === 'rail' ? GROUND.bridge : GROUND.pavement;
  mesh.polygon(
    contour.map((p): V3 => [p.x, y, p.y]),
    ShapeUtils.triangulateShape(contour, []),
    paving,
    UP,
    -SURFACE.paving,
  );
  for (const { width, line, surface } of deck.lanes) {
    const half = width / 2;
    const color =
      width <= CYCLE_LANE ? carriagewayColor('cycleway', 'asphalt') : SURFACE_COLOURS[surface];
    for (let i = 0; i + 3 < line.length; i += 2) {
      const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const [nx, nz] = [((bz - az) / len) * half, (-(bx - ax) / len) * half];
      const y2 = LAYER_Y.carriageways;
      mesh.quad(
        [ax + nx, y2, az + nz],
        [bx + nx, y2, bz + nz],
        [bx - nx, y2, bz - nz],
        [ax - nx, y2, az - nz],
        color,
        UP,
        -SURFACE_OF[surface],
      );
    }
  }
}

/**
 * The structure of a deck under its surface: an edge beam along each side, the abutment at each
 * end down to the ground, its parapets, and its piers.
 */
export function addDeckFrame(
  mesh: MeshBuilder,
  lines: LineBuilder,
  deck: Deck,
  terrain: Terrain,
): void {
  const surface = terrain.decks;
  const { ring } = deck;
  const n = ring.length / 2;
  const ends = deckEnds(deck);
  const [drape, lineDrape] = [mesh.drape, lines.drape];
  const top = (x: number, z: number) => surface.height(x, z) + LAYER_Y.bridges;
  mesh.drape = lines.drape = null;
  for (let i = 0; i < n; i++) {
    const [ax, az] = pointAt(ring, i);
    const [bx, bz] = pointAt(ring, (i + 1) % n);
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) continue;
    const out: V3 = [(bz - az) / len, 0, (ax - bx) / len];
    const [ta, tb] = [top(ax, az), top(bx, bz)];
    const end = ends[i]!;
    const [ga, gb] = [terrain.plain(ax, az), terrain.plain(bx, bz)];
    // An end's wall goes down to the ground it stands on; a side's beam only as deep as the deck.
    const [la, lb] = end ? [ga, gb] : [Math.max(ga, ta - FASCIA), Math.max(gb, tb - FASCIA)];
    if (ta - la > 0.02 || tb - lb > 0.02) {
      mesh.quad([ax, la, az], [bx, lb, bz], [bx, tb, bz], [ax, ta, az], STRUCTURES.parapet, out);
    }
    if (!end && ta > ga + 0.05) lines.segment([ax, la, az], [bx, lb, bz]);
  }
  mesh.drape = lines.drape = surface;
  if (deck.carries !== 'rail') {
    for (const side of deckSides(deck)) addParapet(mesh, lines, side);
  }
  mesh.drape = lines.drape = null;
  for (let i = 0; i + 1 < deck.piers.length; i += 2) {
    const [x, z] = [deck.piers[i]!, deck.piers[i + 1]!];
    const y1 = top(x, z) - FASCIA;
    const y0 = terrain.plain(x, z);
    if (y1 - y0 < 0.3) continue;
    const h = PIER / 2;
    for (const [nx, nz, ax, az, bx, bz] of [
      [1, 0, h, -h, h, h],
      [-1, 0, -h, h, -h, -h],
      [0, 1, h, h, -h, h],
      [0, -1, -h, -h, h, -h],
    ] as const) {
      mesh.quad(
        [x + ax, y0, z + az],
        [x + bx, y0, z + bz],
        [x + bx, y1, z + bz],
        [x + ax, y1, z + az],
        STRUCTURES.parapet,
        [nx, 0, nz],
      );
    }
  }
  [mesh.drape, lines.drape] = [drape, lineDrape];
}

/** The retaining walls along a ramp: from the ground to its top, or down into its cutting. */
export function addRampWalls(
  mesh: MeshBuilder,
  lines: LineBuilder,
  ramp: Ramp,
  terrain: Terrain,
  ramps: readonly Ramp[] = [],
): void {
  const { line, rise, half } = ramp;
  // A wall inside another ramp's roadway stands in the road (two carriageways, a cycle track
  // beside a road): walkable.ts walks through it, so it isn't drawn either.
  const others = ramps.filter((other) => other !== ramp && !other.rail && touches(ramp, other));
  const across = mitres(line, half);
  const edges = Array.from({ length: line.length / 2 }, (_, i) => {
    const [x, z, nx, nz] = [line[i * 2]!, line[i * 2 + 1]!, across[i * 2]!, across[i * 2 + 1]!];
    return [x + nx, z + nz, x - nx, z - nz] as const;
  });
  const [drape, lineDrape] = [mesh.drape, lines.drape];
  mesh.drape = lines.drape = null;
  for (let i = 0; i + 1 < edges.length; i++) {
    if (Math.abs(rise[i]!) < 0.25 && Math.abs(rise[i + 1]!) < 0.25) continue;
    for (const side of [0, 2] as const) {
      const [x0, z0] = [edges[i]![side], edges[i]![side + 1]!];
      const [x1, z1] = [edges[i + 1]![side], edges[i + 1]![side + 1]!];
      const length = Math.hypot(x1 - x0, z1 - z0);
      const parts = others.length ? Math.max(1, Math.ceil(length / WALL_PIECE)) : 1;
      const lift = (t: number) => rise[i]! + (rise[i + 1]! - rise[i]!) * t;
      const stands = (k: number) => {
        const t = (k + 0.5) / parts;
        return !others.some((other) =>
          sameRoadway(other, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, lift(t)),
        );
      };
      // Whole lengths, from one place where it stops to the next: a wall costs what it did.
      for (let k = 0; k < parts; k++) {
        if (!stands(k)) continue;
        const from = k;
        while (k + 1 < parts && stands(k + 1)) k++;
        const [t0, t1] = [from / parts, (k + 1) / parts];
        wallPiece(
          x0 + (x1 - x0) * t0,
          z0 + (z1 - z0) * t0,
          x0 + (x1 - x0) * t1,
          z0 + (z1 - z0) * t1,
          lift(t0),
          lift(t1),
          side,
        );
      }
    }
  }
  function wallPiece(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    ra: number,
    rb: number,
    side: 0 | 2,
  ): void {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) return;
    // Left of the heading for edge 0, right for edge 2: outward.
    const sign = side === 0 ? 1 : -1;
    const [ox, oz] = [((bz - az) / len) * sign, (-(bx - ax) / len) * sign];
    const up = ra > 0 || rb > 0;
    const [ga, gb] = [terrain.plain(ax, az), terrain.plain(bx, bz)];
    if (up) {
      // A wall from the ground up to the ramp's top, its low parapet carried along it.
      const wall = (level: (g: number, r: number) => number): [V3, V3] => [
        [ax, level(ga, ra), az],
        [bx, level(gb, rb), bz],
      ];
      const [wa, wb] = wall((g) => g);
      const [ta, tb] = wall((g, r) => g + Math.max(r, 0) + LAYER_Y.roads);
      const high = Math.max(ra, rb) > 1;
      const [pa, pb] = wall((g, r) => g + Math.max(r, 0) + LAYER_Y.roads + (high ? RAMP_WALL : 0));
      mesh.quad(wa, wb, tb, ta, STRUCTURES.parapet, [ox, 0, oz]);
      if (high) {
        mesh.quad(ta, tb, pb, pa, STRUCTURES.parapet, [ox, 0, oz]);
        mesh.quad(ta, tb, pb, pa, STRUCTURES.coping, [-ox, 0, -oz]);
        lines.segment(pa, pb);
      }
    } else {
      // A cutting's wall: from its floor up past the ground, facing in.
      // The lip fades as the cutting comes up to the ground, so a ramp ends level with the road.
      const lip = (g: number, r: number) => g + Math.min(KERB_TOP, -Math.min(r, 0) * 0.25);
      mesh.quad(
        [ax, cuttingFloor(ga, ra), az],
        [bx, cuttingFloor(gb, rb), bz],
        [bx, lip(gb, rb), bz],
        [ax, lip(ga, ra), az],
        STRUCTURES.parapet,
        [-ox, 0, -oz],
      );
      mesh.quad(
        [ax, ga, az],
        [bx, gb, bz],
        [bx, lip(gb, rb), bz],
        [ax, lip(ga, ra), az],
        STRUCTURES.parapet,
        [ox, 0, oz],
      );
      if (Math.max(-ra, -rb) > 0.8) lines.segment([ax, lip(ga, ra), az], [bx, lip(gb, rb), bz]);
    }
  }
  [mesh.drape, lines.drape] = [drape, lineDrape];
}

/** How high a tunnel's opening stands over its floor (m), at most. */
const OPENING = 3.8;
/** How far back the top of a tunnel's headwall reaches (m): past the ramp's overlap. */
const LID = 1.8;

/** The face of a tunnel's mouth, its dark opening let into it, where a road goes under. */
export function addPortals(
  mesh: MeshBuilder,
  lines: LineBuilder,
  tunnel: Tunnel,
  terrain: Terrain,
): void {
  const { line, half, depth } = tunnel;
  const n = line.length / 2;
  const [drape, lineDrape] = [mesh.drape, lines.drape];
  mesh.drape = lines.drape = null;
  const mouths = [
    [line[0]!, line[1]!, tunnel.mouths[0]],
    [line[line.length - 2]!, line[line.length - 1]!, tunnel.mouths[1]],
  ] as const;
  for (const [index, [x, z, open]] of mouths.entries()) {
    if (!open) continue;
    // Into the tunnel along its line.
    const [px, pz] = index === 0 ? pointAt(line, 1) : pointAt(line, n - 2);
    const length = Math.hypot(px - x, pz - z) || 1;
    const [ux, uz] = [(px - x) / length, (pz - z) / length];
    const [nx, nz] = [-uz, ux];
    const wide = half + 0.35;
    const ground = terrain.plain(x, z);
    const floor = ground - depth + LAYER_Y.roads;
    const top = ground + KERB_TOP + 0.2;
    const corners = (w: number, y0: number, y1: number, shift: number) => {
      const [ox, oz] = [ux * shift, uz * shift];
      return [
        [x - nx * w + ox, y0, z - nz * w + oz],
        [x + nx * w + ox, y0, z + nz * w + oz],
        [x + nx * w + ox, y1, z + nz * w + oz],
        [x - nx * w + ox, y1, z - nz * w + oz],
      ] as [V3, V3, V3, V3];
    };
    const [a, b, c, d] = corners(wide, floor, top, 0);
    mesh.quad(a, b, c, d, STRUCTURES.parapet, [-ux, 0, -uz]);
    lines.segment(d, c);
    // The headwall's top, back over the length a ramp runs on into the tunnel, which would
    // otherwise show as a slot in the street behind the portal.
    const [, , g, h] = corners(wide, top, top, LID);
    mesh.quad(d, c, g, h, STRUCTURES.coping, UP);
    lines.segment(h, g);
    const opening = Math.min(depth - 0.3, OPENING);
    mesh.quad(...corners(half - 0.2, floor, floor + opening, -0.03), GROUND.tunnel, [-ux, 0, -uz]);
  }
  [mesh.drape, lines.drape] = [drape, lineDrape];
}
