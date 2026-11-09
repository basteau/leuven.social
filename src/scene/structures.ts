import { ShapeUtils, Vector2 } from 'three';

import { CYCLE_LANE } from '../data/city.ts';
import type { Carriageway, Deck, Tank, Tunnel } from '../data/city.ts';
import { pointInRing } from '../data/geometry.ts';
import { deckEnds, deckSides } from '../data/structures.ts';
import type { GroundStep, Terrain } from '../data/terrain.ts';
import { LAYER_Y } from './ground.ts';
import type { LineBuilder, MeshBuilder, V3 } from './mesh-builder.ts';
import { SURFACE, SURFACE_OF } from './paint.ts';
import { GROUND, PAINT, STRUCTURES, SURFACE_COLOURS, carriagewayColor } from './palette.ts';

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
/** A step this high starts a railing, which grows this much a metre, and is inked from this. */
const GUARD_FROM = 0.7;
const GUARD_GROWS = 1.5;
const INK_FROM = 0.8;
/** A step lower than this is a seam in the road (m), drawn a length of this at a time (m). */
export const SEAM = 0.3;
const SEAM_PIECE = 1.5;
/** How far in from a seam the surface over it is read (m). */
const SEAM_IN = 0.15;
/** A railing or low wall along a ramp's top (m). */
const RAMP_WALL = 1.05;
/** How far a kerb stands over a drop on its street side (m), at most. */
const KERB_TOP = 0.5;

/** How far past a lane's end to look for the road it's part of (m). */
const PAST_END = 3;
/** Roads on a deck get a dashed centre line from this wide (m), this long and this often. */
const DASHED_FROM = 6;
const DASH = 2.5;
const DASH_EVERY = 7.5;
const DASH_WIDE = 0.14;

const pointAt = (ring: ArrayLike<number>, i: number): [number, number] => [
  ring[i * 2]!,
  ring[i * 2 + 1]!,
];

/** A deck's surface: its outline over its ground, and its ways as ribbons of their own. */
export function addDeckSurface(
  mesh: MeshBuilder,
  deck: Deck,
  carriageways: readonly Carriageway[] = [],
): void {
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
      width <= CYCLE_LANE
        ? carriagewayColor('cycleway', 'asphalt')
        : (roadRunningOn(line, carriageways) ?? SURFACE_COLOURS[surface]);
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

/** The colour of the road a lane runs on from, past either end of it: a deck is that road still. */
function roadRunningOn(
  line: ArrayLike<number>,
  carriageways: readonly Carriageway[],
): number | undefined {
  const n = line.length / 2;
  for (const [i, j] of [
    [0, 1],
    [n - 1, n - 2],
  ] as const) {
    const [x, z] = pointAt(line, i);
    const [ox, oz] = pointAt(line, j);
    const length = Math.hypot(x - ox, z - oz) || 1;
    const [px, pz] = [x + ((x - ox) / length) * PAST_END, z + ((z - oz) / length) * PAST_END];
    const on = carriageways.find((c) => c.kind !== 'cycleway' && pointInRing(c.ring, px, pz));
    if (on) return carriagewayColor(on.kind, on.surface);
  }
  return undefined;
}

/** A lane's dashes down its middle, as the road it comes from has them. */
export function addDeckPaint(mesh: MeshBuilder, deck: Deck): void {
  const y = LAYER_Y.carriageways + 0.01;
  for (const { width, line } of deck.lanes) {
    if (width < DASHED_FROM) continue;
    let run = 0;
    for (let i = 0; i + 3 < line.length; i += 2) {
      const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const [ux, uz] = [(bx - ax) / len, (bz - az) / len];
      const [nx, nz] = [uz * (DASH_WIDE / 2), -ux * (DASH_WIDE / 2)];
      const first = Math.ceil(run / DASH_EVERY) * DASH_EVERY - run;
      for (let at = first; at + DASH <= len; at += DASH_EVERY) {
        const [x0, z0, x1, z1] = [
          ax + ux * at,
          az + uz * at,
          ax + ux * (at + DASH),
          az + uz * (at + DASH),
        ];
        mesh.quad(
          [x0 + nx, y, z0 + nz],
          [x1 + nx, y, z1 + nz],
          [x1 - nx, y, z1 - nz],
          [x0 - nx, y, z0 - nz],
          PAINT.line,
          UP,
        );
      }
      run += len;
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

/**
 * A step of a few centimetres between two lengths of ramp that don't quite agree: no wall, but the
 * road's own. Its face takes the colour of the surface over it, a length at a time, and is lit as
 * level ground is, so the street runs on over it without a line.
 */
export function addGroundSeam(
  mesh: MeshBuilder,
  { ax, az, bx, bz, high, low }: GroundStep,
  terrain: Terrain,
  surfaceOver: (x: number, z: number) => { color: number; y: number } | null,
): void {
  const length = Math.hypot(bx - ax, bz - az);
  if (length < 1e-6) return;
  // The drop is to the right of a to b: the surface over it lies to the left.
  const [ix, iz] = [(-(bz - az) / length) * SEAM_IN, ((bx - ax) / length) * SEAM_IN];
  const parts = Math.ceil(length / SEAM_PIECE);
  const [drape, level] = [mesh.drape, mesh.level];
  [mesh.drape, mesh.level] = [null, true];
  const at = (t: number, rises: readonly [number, number], over: number): V3 => {
    const [x, z] = [ax + (bx - ax) * t, az + (bz - az) * t];
    return [x, terrain.plain(x, z) + rises[0] + (rises[1] - rises[0]) * t + over, z];
  };
  for (let k = 0; k < parts; k++) {
    const [t0, t1] = [k / parts, (k + 1) / parts];
    const mid = at((t0 + t1) / 2, high, 0);
    const over = surfaceOver(mid[0] + ix, mid[2] + iz) ?? {
      color: SURFACE_COLOURS.asphalt,
      y: LAYER_Y.carriageways,
    };
    mesh.quad(
      at(t0, low, 0),
      at(t1, low, 0),
      at(t1, high, over.y),
      at(t0, high, over.y),
      over.color,
      [-ix, 0, -iz],
    );
  }
  [mesh.drape, mesh.level] = [drape, level];
}

/**
 * A ground step as a wall: one face from the low side up past the street's own layers, facing the
 * low side. Over a drop worth falling down, a railing along the top where a ramp is the high side,
 * a kerb where the street is. It stands where the heights say and nowhere else (`GroundStep`).
 */
export function addGroundStep(
  mesh: MeshBuilder,
  lines: LineBuilder,
  { ax, az, bx, bz, high, low }: GroundStep,
  terrain: Terrain,
  guarded = true,
): void {
  const length = Math.hypot(bx - ax, bz - az);
  if (length < 1e-6) return;
  const [ox, oz] = [(bz - az) / length, -(bx - ax) / length];
  const [ga, gb] = [terrain.plain(ax, az), terrain.plain(bx, bz)];
  const [ta, tb] = [ga + high[0] + LAYER_Y.carriageways, gb + high[1] + LAYER_Y.carriageways];
  const [drap, drbp] = [high[0] - low[0], high[1] - low[1]];
  const [drape, lineDrape] = [mesh.drape, lines.drape];
  mesh.drape = lines.drape = null;
  mesh.quad(
    [ax, ga + low[0], az],
    [bx, gb + low[1], bz],
    [bx, tb, bz],
    [ax, ta, az],
    STRUCTURES.retaining,
    [ox, 0, oz],
  );
  const ramp = high[0] + high[1] > 0;
  const most = ramp ? RAMP_WALL : KERB_TOP;
  // Under a deck there's nothing to fall off, and the deck is where a railing would come through.
  const guard = (drop: number) =>
    guarded ? Math.min(most, Math.max(0, drop - GUARD_FROM) * GUARD_GROWS) : 0;
  const [ua, ub] = [ta + guard(drap), tb + guard(drbp)];
  if (ua > ta || ub > tb) {
    const [p, q, r, s]: [V3, V3, V3, V3] = [
      [ax, ta, az],
      [bx, tb, bz],
      [bx, ub, bz],
      [ax, ua, az],
    ];
    mesh.quad(p, q, r, s, STRUCTURES.retaining, [ox, 0, oz]);
    mesh.quad(p, q, r, s, ramp ? STRUCTURES.coping : STRUCTURES.retaining, [-ox, 0, -oz]);
  }
  if (guarded && Math.max(drap, drbp) > INK_FROM) lines.segment([ax, ua, az], [bx, ub, bz]);
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
    mesh.quad(a, b, c, d, STRUCTURES.retaining, [-ux, 0, -uz]);
    lines.segment(d, c);
    // The headwall's top, back over the length a ramp runs on into the tunnel, which would
    // otherwise show as a slot in the street behind the portal.
    const [, , g, h] = corners(wide, top, top, LID);
    mesh.quad(d, c, g, h, STRUCTURES.retaining, UP);
    lines.segment(h, g);
    const opening = Math.min(depth - 0.3, OPENING);
    mesh.quad(...corners(half - 0.2, floor, floor + opening, -0.03), GROUND.tunnel, [-ux, 0, -uz]);
  }
  [mesh.drape, lines.drape] = [drape, lineDrape];
}
