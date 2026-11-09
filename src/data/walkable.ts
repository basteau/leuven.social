/**
 * Where a person can walk: anywhere on the map's ground, lawns, car parks and verges included,
 * except into a building or tank (its courtyards count too: they're private), into the water,
 * onto railway land or up onto a platform. Roads, squares, footpaths and bridge decks open the
 * ground again wherever they cross those, so a bridge carries you over the river and a level
 * crossing over the tracks. Bridge parapets are low walls: they keep you on the deck.
 *
 * A raster of 1 m cells, filled in 64 m tiles the first time anything asks about them, so the
 * map pays nothing until someone walks, and then only for the streets they reach.
 */

import { CellGrid, TILE, inRing, ringBox, wallPush } from './cell-grid.ts';
import type { Wall } from './cell-grid.ts';
import type { Bounds, City, Deck, Ramp, Tunnel } from './city.ts';
import { areaIndex } from './geometry.ts';
import { deckEnds, deckSides } from './structures.ts';
import { FLAT, mitres } from './terrain.ts';
import type { Terrain } from './terrain.ts';

/** How many cells out from a building's walls the places beside it reach. */
const APRON = 5;

/** Cell size in metres: narrower than any footpath, so every path stays connected. */
export const WALK_CELL = 1;
/** Narrow paths still get a ribbon at least this wide, so diagonal ones never break apart. */
const MIN_HALF_WIDTH = 0.75;

/**
 * A cell's value: closed ground, open ground, a street (a road, square, path or bridge deck), or
 * a building, tank or parapet (its height in metres + 3). Walks start on a street: dry ground
 * behind a block can be a garden walled in by houses, with no way out.
 */
const CLOSED = 0;
const OPEN = 1;
const STREET = 2;
/** A solid of no height: a trunk or a bench, which closes its cell but nothing over it. */
const SOLID = 3;
/**
 * A parapet's height (m), and how far past it the cells close, on the side away from the deck
 * only (`bridgeParapets` draws each with the water on its right). A metre can't be stepped over
 * on the grid at any angle, and the deck keeps every cell: closed on both sides, a footbridge
 * under 3 m wide lost its whole width to its own two parapets.
 */
const PARAPET_HEIGHT = 1.1;
const PARAPET_BAND = 1;
/** Half a parapet's thickness as drawn, capstone included (m). */
const PARAPET_FACE = 0.25;

/**
 * What stands on the ground at about knee to head height and is drawn too small for the city
 * file to hold as a wall: tree trunks, lamp posts, benches, racks, statues, parasols. Posts are
 * flat [x, z, radius, …] triples, footprints closed rings, each as the scene draws it.
 */
export interface Solids {
  posts: ArrayLike<number>;
  rings: readonly ArrayLike<number>[];
}
/**
 * A post at least this round (m) also closes the walk cell its centre covers, so routes go
 * round it (a trunk); a thinner one (a lamp post) is only met as drawn, so a narrow pavement
 * with a lamp on it keeps its cells and a route along it.
 */
const GRID_POST = 0.25;
/** Half a deck railing's thickness, as met (m). */
const RAILING = 0.22;
/**
 * On the level of decks and tunnels, a cell just past an open end: no place to stand or be routed
 * to, but not an edge to be held back at either, so a walker can step off onto the ground.
 */
const EXIT = 2;
/** A ramp's tip is walled in this many pieces, so a neighbouring roadway can leave out its part. */
const TIP_PIECES = 6;
/** How far a deck's end opens the ground either side of it (m). */
const END_PAD = 1.2;
/** A step this high at the edge of a ramp is walked over; a higher one is walled (m). */
const STEP_UP = 0.4;
/** Two levels this close (m) meet: a walker passes between them at no step. */
const SAME_HEIGHT = 0.6;
/** A deck's surface over the terrain beyond its own rise, as drawn (m). */
export const DECK_Y = 0.13;

export type WalkLayers = Pick<
  City,
  'area' | 'bounds' | 'roads' | 'plazas' | 'paths' | 'buildings' | 'tanks'
> &
  Partial<
    Pick<
      City,
      'water' | 'railLand' | 'platforms' | 'bridges' | 'parapets' | 'decks' | 'ramps' | 'tunnels'
    >
  >;

interface Shape {
  ring: ArrayLike<number>;
  /** 0 for ground that closes, 1 for walkable surfaces, the height code for buildings. */
  value: number;
}
interface Ribbon {
  line: ArrayLike<number>;
  half: number;
  /** As for a shape: open for a path, a height code for a parapet. */
  value: number;
  /** Close only the right of the line, as it runs: a parapet's outside. */
  rightOnly?: boolean;
}

/** Whether (x, z) lies within `half` of a line. */
function nearLine(line: ArrayLike<number>, x: number, z: number, half: number): boolean {
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    const [dx, dz] = [bx - ax, bz - az];
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(ax + dx * t - x, az + dz * t - z) <= half) return true;
  }
  return false;
}

/**
 * The edges of a ramp that are walls (a step past `STEP_UP`), as open lines with the drop on their
 * right, as `Ribbon.rightOnly` closes.
 */
export function rampEdges({ line, rise, half }: Pick<Ramp, 'line' | 'rise' | 'half'>): number[][] {
  const n = line.length / 2;
  const across = mitres(line, half);
  const runs: number[][] = [];
  for (const side of [1, -1]) {
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 4) runs.push(side > 0 ? run : reverseLine(run));
      run = [];
    };
    const edge = (i: number) =>
      [line[i * 2]! + across[i * 2]! * side, line[i * 2 + 1]! + across[i * 2 + 1]! * side] as const;
    for (let i = 0; i < n; i++) {
      const high = Math.abs(rise[i]!) >= STEP_UP;
      if (high) run.push(...edge(i));
      const next = i + 1 < n ? Math.abs(rise[i + 1]!) >= STEP_UP : high;
      if (high === next) {
        if (!high) flush();
        continue;
      }
      // The rise is linear between points: the wall starts or stops where it passes a step.
      const [a, b] = [Math.abs(rise[i]!), Math.abs(rise[i + 1]!)];
      const t = (STEP_UP - a) / (b - a);
      const [ax, az] = edge(i);
      const [bx, bz] = edge(i + 1);
      run.push(ax + (bx - ax) * t, az + (bz - az) * t);
      if (high) flush();
    }
    flush();
  }
  return runs;
}

/** Across the high end of a ramp, as an open line with the way past its tip on its right. */
function rampTip({ line, rise, half }: Pick<Ramp, 'line' | 'rise' | 'half'>): number[] | null {
  if (Math.abs(rise[0]!) < STEP_UP) return null;
  const across = mitres(line, half);
  const [x, z, nx, nz] = [line[0]!, line[1]!, across[0]!, across[1]!];
  const out: number[] = [];
  for (let k = 0; k <= TIP_PIECES; k++) {
    const t = (2 * k) / TIP_PIECES - 1;
    out.push(x + nx * t, z + nz * t);
  }
  return out;
}

/** The short lines just past a tunnel's open mouths, along it. */
function tunnelExits({ line, mouths }: Tunnel): number[][] {
  const out: number[][] = [];
  const n = line.length / 2;
  for (const [open, i, j] of [
    [mouths[0], 0, 1],
    [mouths[1], n - 1, n - 2],
  ] as const) {
    if (!open) continue;
    const [x, z] = [line[i * 2]!, line[i * 2 + 1]!];
    const [dx, dz] = [x - line[j * 2]!, z - line[j * 2 + 1]!];
    const length = Math.hypot(dx, dz) || 1;
    out.push([x, z, x + (dx / length) * END_PAD, z + (dz / length) * END_PAD]);
  }
  return out;
}

/** A ramp and the box round its roadway, worked out once. */
interface RampBox {
  ramp: Ramp;
  box: Bounds;
}

/** The pieces of an edge line (flat [x, z, …]) that don't lie on another ramp's roadway. */
function outsideOthers(line: readonly number[], own: Ramp, ramps: readonly RampBox[]): number[][] {
  const box = ringBox(line);
  const others = ramps.filter(({ ramp, box: b }) => {
    return (
      ramp !== own &&
      b.minX <= box.maxX &&
      b.maxX >= box.minX &&
      b.minZ <= box.maxZ &&
      b.maxZ >= box.minZ
    );
  });
  if (!others.length) return [Array.from(line)];
  const pieces: number[][] = [];
  let run: number[] = [];
  const onOther = (x: number, z: number) =>
    others.some(({ ramp: r }) => nearLine(r.line, x, z, r.half - 0.3));
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    if (onOther((ax + bx) / 2, (az + bz) / 2)) {
      if (run.length >= 4) pieces.push(run);
      run = [];
      continue;
    }
    if (!run.length) run.push(ax, az);
    run.push(bx, bz);
  }
  if (run.length >= 4) pieces.push(run);
  return pieces;
}

function reverseLine(line: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = line.length - 2; i >= 0; i -= 2) out.push(line[i]!, line[i + 1]!);
  return out;
}

const heightCode = (height: number) => Math.min(255 - SOLID, Math.ceil(height)) + SOLID;

/** A trunk against a facade keeps the building's height in its cells. */
const keep = (value: number) => (old: number) => value === SOLID && old > SOLID;

/**
 * The level above (or below) the ground, as a grid of its own: the decks people walk on and the
 * tunnels they walk through. Walks enter it where its height meets the ground's (`WalkGrid.link`).
 */
export interface LevelGrid {
  readonly cols: number;
  readonly rows: number;
  cellAt(x: number, z: number): number;
  centre(cell: number): [number, number];
  open(cell: number): boolean;
  walkable(x: number, z: number): boolean;
  nearest(x: number, z: number, radius: number): [number, number] | null;
  around(x: number, z: number, radius: number, most: number): [number, number][];
  closed(x: number, z: number): number;
  wallOverlap(x: number, z: number, radius: number, out: [number, number]): number;
}

export class WalkGrid {
  readonly #grid: CellGrid;
  readonly #area: readonly Bounds[];
  /** What touches each tile, in drawing order: surfaces and paths first, buildings on top. */
  readonly #shapes: Shape[][];
  readonly #ribbons: Ribbon[][];
  readonly #walls: Wall[][];
  /** Scratch for `wallOverlap`, which a step calls several times: nothing allocated. */
  readonly #sum: [number, number, number] = [0, 0, 0];
  #query = 0;
  readonly #terrain: Terrain;
  /** The level of decks and tunnels; cells off it are closed. */
  readonly #upper: CellGrid;
  readonly #upperRings: { deck: Deck; box: Bounds }[][];
  readonly #upperRibbons: { tunnel: Tunnel; box: Bounds }[][];
  readonly #upperExits: { line: number[]; half: number }[][];
  readonly #upperWalls: Wall[][];
  readonly #water: ArrayLike<number>[][];
  /** Whether the level ever appears (a map without bridges pays nothing). */
  readonly #levels: boolean;
  readonly #links = new Map<number, boolean>();
  readonly #view: LevelGrid;

  constructor(
    city: WalkLayers,
    solids: Solids = { posts: [], rings: [] },
    terrain: Terrain = FLAT,
  ) {
    this.#terrain = terrain;
    this.#grid = new CellGrid(
      city.bounds,
      (tile, x0, z0, t) => this.#fill(tile, x0, z0, t),
      WALK_CELL,
    );
    this.#area = city.area;
    const tiles = this.#grid.tileCount;
    this.#shapes = Array.from({ length: tiles }, () => []);
    this.#ribbons = Array.from({ length: tiles }, () => []);
    this.#walls = Array.from({ length: tiles }, () => []);
    this.#upper = new CellGrid(
      city.bounds,
      (tile, x0, z0, t) => this.#fillUpper(tile, x0, z0, t),
      WALK_CELL,
    );
    this.#upperRings = Array.from({ length: tiles }, () => []);
    this.#upperRibbons = Array.from({ length: tiles }, () => []);
    this.#upperExits = Array.from({ length: tiles }, () => []);
    this.#upperWalls = Array.from({ length: tiles }, () => []);
    this.#water = Array.from({ length: tiles }, () => []);

    const each = (box: Bounds, visit: (tile: number) => void) => this.#grid.eachTile(box, visit);
    const decks = (city.decks ?? []).filter((d) => d.carries !== 'rail');
    const tunnels = city.tunnels ?? [];
    this.#levels = decks.length + tunnels.length > 0;
    this.#view = {
      cols: this.#upper.cols,
      rows: this.#upper.rows,
      cellAt: (x, z) => this.#upper.cellAt(x, z),
      centre: (cell) => this.#upper.centre(cell),
      open: (cell) => this.#upper.value(cell, CLOSED) === OPEN,
      walkable: (x, z) => this.#upper.value(this.#upper.cellAt(x, z), CLOSED) === OPEN,
      nearest: (x, z, radius) =>
        this.#upper.nearest(x, z, radius, (cell) => this.#upper.value(cell, CLOSED) === OPEN),
      around: (x, z, radius, most) =>
        this.#upper.around(x, z, radius, (cell) => this.#upper.value(cell, CLOSED) === OPEN, most),
      closed: (x, z) => this.#upper.blend(x, z, (v) => v === CLOSED),
      wallOverlap: (x, z, radius, out) => this.#overlap(this.#upperWalls, x, z, radius, out),
    };
    for (const deck of decks) {
      const box = ringBox(deck.ring);
      each(box, (t) => this.#upperRings[t]!.push({ deck, box }));
      for (const line of deckSides(deck)) {
        const wall = { line, ring: false, half: RAILING, box: ringBox(line, RAILING), seen: 0 };
        each(wall.box, (t) => this.#upperWalls[t]!.push(wall));
      }
      // Each end opens to the street it meets, whatever the survey left there.
      const n = deck.ring.length / 2;
      for (const [i, end] of deckEnds(deck).entries()) {
        if (!end) continue;
        const j = (i + 1) % n;
        const line = [
          deck.ring[i * 2]!,
          deck.ring[i * 2 + 1]!,
          deck.ring[j * 2]!,
          deck.ring[j * 2 + 1]!,
        ];
        each(ringBox(line, END_PAD), (t) => {
          this.#ribbons[t]!.push({ line, half: END_PAD, value: STREET });
          this.#upperExits[t]!.push({ line, half: END_PAD });
        });
      }
    }
    for (const tunnel of tunnels) {
      const box = ringBox(tunnel.line, tunnel.half);
      each(box, (t) => this.#upperRibbons[t]!.push({ tunnel, box }));
      for (const line of tunnelExits(tunnel)) {
        each(ringBox(line, tunnel.half), (t) => {
          this.#upperExits[t]!.push({ line, half: tunnel.half });
        });
      }
    }
    const closing = [...(city.water ?? []), ...(city.railLand ?? []), ...(city.platforms ?? [])];
    for (const ring of city.water ?? []) each(ringBox(ring), (t) => this.#water[t]!.push(ring));
    for (const ring of closing) {
      each(ringBox(ring), (t) => this.#shapes[t]!.push({ ring, value: CLOSED }));
    }
    for (const ring of [...city.roads, ...city.plazas, ...(city.bridges ?? [])]) {
      each(ringBox(ring), (t) => this.#shapes[t]!.push({ ring, value: STREET }));
    }
    // A ramp opens its top, over water or tracks too, and walls off its sides once they are
    // high enough to be a drop (`rampWalls`).
    const roadRamps = (city.ramps ?? [])
      .filter((ramp) => !ramp.rail)
      .map((ramp) => ({ ramp, box: ringBox(ramp.line, ramp.half) }));
    for (const { ramp } of roadRamps) {
      const { line, half } = ramp;
      each(ringBox(line, half), (t) => this.#ribbons[t]!.push({ line, half, value: STREET }));
      const tip = rampTip(ramp);
      for (const whole of tip ? [...rampEdges(ramp), tip] : rampEdges(ramp)) {
        // A wall inside another ramp's roadway (two carriageways, a cycle track beside a road)
        // divides nothing: the walled drop is the outer edge of the two.
        for (const edge of outsideOthers(whole, ramp, roadRamps)) {
          const ribbon = {
            line: edge,
            half: PARAPET_BAND,
            value: heightCode(PARAPET_HEIGHT),
            rightOnly: true,
          };
          each(ringBox(edge, PARAPET_BAND), (t) => this.#ribbons[t]!.push(ribbon));
          const wall = {
            line: edge,
            ring: false,
            half: RAILING,
            box: ringBox(edge, RAILING),
            seen: 0,
          };
          each(wall.box, (t) => this.#walls[t]!.push(wall));
        }
      }
    }
    for (const { line, width } of city.paths) {
      const half = Math.max(width / 2, MIN_HALF_WIDTH);
      each(ringBox(line, half), (t) => this.#ribbons[t]!.push({ line, half, value: STREET }));
    }
    // Tanks and silos are as solid as buildings, and as tall.
    for (const { ring, height } of [...city.buildings, ...city.tanks]) {
      const value = heightCode(height);
      const wall = { line: ring, ring: true, half: 0, box: ringBox(ring), seen: 0 };
      each(wall.box, (t) => {
        this.#shapes[t]!.push({ ring, value });
        this.#walls[t]!.push(wall);
      });
    }
    for (const line of city.parapets ?? []) {
      const ribbon = {
        line,
        half: PARAPET_BAND,
        value: heightCode(PARAPET_HEIGHT),
        rightOnly: true,
      };
      each(ringBox(line, PARAPET_BAND), (t) => this.#ribbons[t]!.push(ribbon));
      const wall = {
        line,
        ring: false,
        half: PARAPET_FACE,
        box: ringBox(line, PARAPET_FACE),
        seen: 0,
      };
      each(wall.box, (t) => this.#walls[t]!.push(wall));
    }
    // Low solids: met as drawn, and closing the cells they cover, at no height (`SOLID`), so
    // the camera and a click's ray pass over them.
    const { posts } = solids;
    for (let i = 0; i + 2 < posts.length; i += 3) {
      const [x, z, half] = [posts[i]!, posts[i + 1]!, posts[i + 2]!];
      const line = [x, z, x, z];
      const wall = { line, ring: false, half, box: ringBox(line, half), seen: 0 };
      const ribbon = { line, half, value: SOLID };
      each(wall.box, (t) => {
        this.#walls[t]!.push(wall);
        if (half >= GRID_POST) this.#ribbons[t]!.push(ribbon);
      });
    }
    for (const ring of solids.rings) {
      const wall = { line: ring, ring: true, half: 0, box: ringBox(ring), seen: 0 };
      each(wall.box, (t) => {
        this.#shapes[t]!.push({ ring, value: SOLID });
        this.#walls[t]!.push(wall);
      });
    }
    // Within each tile: what closes the ground, then what opens it again, then what stands on
    // it, so a bridge crosses the river and a building cuts through the road under it.
    for (const list of this.#shapes) list.sort((a, b) => a.value - b.value);
    for (const list of this.#ribbons) list.sort((a, b) => a.value - b.value);
  }

  get cols(): number {
    return this.#grid.cols;
  }

  get rows(): number {
    return this.#grid.rows;
  }

  /** The cell holding (x, z), or -1 off the grid. */
  cellAt(x: number, z: number): number {
    return this.#grid.cellAt(x, z);
  }

  /** The centre of a cell, in metres. */
  centre(cell: number): [number, number] {
    return this.#grid.centre(cell);
  }

  /** A cell's raw value; cells off the grid are closed. */
  value(cell: number): number {
    return this.#grid.value(cell, CLOSED);
  }

  open(cell: number): boolean {
    const v = this.value(cell);
    return v === OPEN || v === STREET;
  }

  /** Whether a cell is a road, square, path or bridge deck: somewhere a walk can start. */
  street(cell: number): boolean {
    return this.value(cell) === STREET;
  }

  /** The grid of decks and tunnels, or null if the map has none. */
  get upper(): LevelGrid | null {
    return this.#levels ? this.#view : null;
  }

  /** Whether a cell is on the level of decks and tunnels. */
  onUpper(cell: number): boolean {
    return this.#upper.value(cell, CLOSED) === OPEN;
  }

  /** How high the level of decks and tunnels lies at (x, z), or NaN off it. */
  upperHeight(x: number, z: number): number {
    const [c, r] = this.#upper.tileOf(x, z);
    const t = r * this.#upper.tilesX + c;
    for (const { deck, box } of this.#upperRings[t]!) {
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      if (inRing(deck.ring, x, z)) return this.#terrain.decks.height(x, z) + DECK_Y;
    }
    for (const { tunnel, box } of this.#upperRibbons[t]!) {
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      if (nearLine(tunnel.line, x, z, tunnel.half)) return this.#terrain.plain(x, z) - tunnel.depth;
    }
    return Number.NaN;
  }

  /**
   * Whether a walker can pass between the ground and the upper level at this cell, at no step:
   * the cell is open on both and they lie at about the same height there.
   */
  link(cell: number): boolean {
    const cached = this.#links.get(cell);
    if (cached !== undefined) return cached;
    let linked = false;
    if (this.onUpper(cell) && this.open(cell)) {
      const [x, z] = this.centre(cell);
      const high = this.upperHeight(x, z);
      linked = !Number.isNaN(high) && Math.abs(high - this.#terrain.height(x, z)) < SAME_HEIGHT;
    }
    this.#links.set(cell, linked);
    return linked;
  }

  /** The level a walker is on after stepping to (x, z), on level `level` before it. */
  levelAt(level: number, x: number, z: number): number {
    if (!this.#levels) return 0;
    const cell = this.cellAt(x, z);
    if (level === 1) return this.onUpper(cell) ? 1 : 0;
    return this.link(cell) ? 1 : 0;
  }

  /** Whether (x, z) is in an open cell. */
  walkable(x: number, z: number): boolean {
    return this.open(this.cellAt(x, z));
  }

  /**
   * How closed the ground is at (x, z), from 0 to 1: whether the cells round it are water,
   * railway or off the map, blended bilinearly between their centres. The edge runs where it
   * crosses a half, as a nearly straight line even along a staircase of cells. Walls are not
   * in it: bodies meet those as drawn (`wallOverlap`).
   */
  closed(x: number, z: number): number {
    return this.#grid.blend(x, z, (v) => v === CLOSED);
  }

  /**
   * How far a circle of `radius` at (x, z) reaches into walls (m), 0 where it's clear: the
   * outlines of buildings, tanks and parapets as drawn, not their cells, so a facade at any
   * angle is a straight line and a corner a point to slide round. Writes the way out into
   * `out`, summed over every face it touches, so in a corner it points out of the corner and in
   * a lane between two walls it balances. A centre inside a footprint is pushed out through
   * the nearest face.
   */
  wallOverlap(x: number, z: number, radius: number, out: [number, number]): number {
    return this.#overlap(this.#walls, x, z, radius, out);
  }

  #overlap(
    walls: readonly (readonly Wall[])[],
    x: number,
    z: number,
    radius: number,
    out: [number, number],
  ): number {
    const sum = this.#sum;
    [sum[0], sum[1], sum[2]] = [0, 0, 0];
    const query = ++this.#query;
    const [c0, r0] = this.#grid.tileOf(x - radius, z - radius);
    const [c1, r1] = this.#grid.tileOf(x + radius, z + radius);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        wallPush(walls[r * this.#grid.tilesX + c]!, x, z, radius, query, sum);
      }
    }
    const length = Math.hypot(sum[0], sum[1]);
    if (length < 1e-9) return 0;
    [out[0], out[1]] = [sum[0] / length, sum[1] / length];
    return sum[2];
  }

  /** Roof height of the building over (x, z), or 0 where there is none. */
  buildingHeight(x: number, z: number): number {
    const v = this.value(this.cellAt(x, z));
    return v >= SOLID ? v - SOLID : 0;
  }

  /**
   * The walkable cell centre nearest (x, z) within `radius` metres, or null; with `street`, the
   * nearest street cell, so a walk never starts in a garden walled in by houses.
   */
  nearest(x: number, z: number, radius: number, street = false): [number, number] | null {
    return this.#grid.nearest(x, z, radius, (cell) =>
      street ? this.street(cell) : this.open(cell),
    );
  }

  /**
   * The open cells (their centres) within `apron` cells of the walls of the building at (x, z)
   * and of those joined to it (a terrace is one block), and within `radius` metres of (x, z):
   * the places beside it, on every side, past a café's tables or a bench along its front. Empty
   * if (x, z) is not in a building.
   */
  besideBuilding(x: number, z: number, radius: number, apron = APRON): [number, number][] {
    const start = this.cellAt(x, z);
    if (start < 0 || this.buildingHeight(x, z) === 0) return [];
    const { cols, rows } = this;
    // How far each cell reached is from the building, in steps: 0 in it.
    const steps = new Map([[start, 0]]);
    const beside: number[] = [];
    // The building first (its cells go on the end and come off it), then out from its walls
    // in rings (theirs go on the front), so each cell is reached by its fewest steps.
    const queue = [start];
    while (queue.length > 0) {
      const cell = queue.pop()!;
      const step = steps.get(cell)!;
      const [c, r] = [cell % cols, Math.floor(cell / cols)];
      for (const [nc, nr] of [
        [c - 1, r],
        [c + 1, r],
        [c, r - 1],
        [c, r + 1],
      ] as const) {
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const next = nr * cols + nc;
        const [cx, cz] = this.centre(next);
        if (steps.has(next) || Math.hypot(cx - x, cz - z) > radius) continue;
        if (this.value(next) >= SOLID) {
          if (step > 0) continue; // another building across the street
          steps.set(next, 0);
          queue.push(next);
        } else if (step < apron) {
          steps.set(next, step + 1);
          queue.unshift(next);
          if (this.open(next)) beside.push(next);
        }
      }
    }
    return beside.map((cell) => this.centre(cell));
  }

  /** Up to `most` open places within `radius` of (x, z), nearest first and spread out. */
  around(x: number, z: number, radius: number, most: number): [number, number][] {
    return this.#grid.around(x, z, radius, (cell) => this.open(cell), most);
  }

  #fillUpper(tile: Uint8Array, x0: number, z0: number, t: number): void {
    for (const { deck } of this.#upperRings[t]!)
      this.#upper.fillRing(tile, deck.ring, OPEN, x0, z0);
    for (const { tunnel } of this.#upperRibbons[t]!) {
      this.#upper.fillRibbon(tile, tunnel.line, tunnel.half, OPEN, x0, z0);
    }
    for (const { line, half } of this.#upperExits[t]!) {
      this.#upper.fillRibbon(tile, line, half, EXIT, x0, z0, (old) => old === OPEN);
    }
  }

  /**
   * Water under a deck stays water: the survey draws a road across a bridge, and a road opens what
   * it covers, so at the level of the ground that road would be a path over the river.
   */
  #waterUnderDecks(tile: Uint8Array, x0: number, z0: number, t: number): void {
    const decks = this.#upperRings[t]!;
    const rivers = decks.length ? this.#water[t]! : [];
    if (!rivers.length) return;
    const [wet, under] = [new Uint8Array(tile.length), new Uint8Array(tile.length)];
    for (const ring of rivers) this.#grid.fillRing(wet, ring, 1, x0, z0);
    for (const { deck } of decks) this.#grid.fillRing(under, deck.ring, 1, x0, z0);
    const { size } = this.#grid;
    const across = Math.round(Math.sqrt(tile.length));
    for (let i = 0; i < tile.length; i++) {
      if (!wet[i] || !under[i]) continue;
      const x = x0 + ((i % across) + 0.5) * size;
      const z = z0 + (Math.floor(i / across) + 0.5) * size;
      // Where the deck comes down to the ground it's stepped onto from there: that stays.
      const gap = this.#terrain.decks.height(x, z) + DECK_Y - this.#terrain.height(x, z);
      if (gap >= SAME_HEIGHT) tile[i] = CLOSED;
    }
  }

  /** Rasterises one tile from everything that touches it. */
  #fill(tile: Uint8Array, x0: number, z0: number, t: number): void {
    const grid = this.#grid;
    const [shapes, ribbons] = [this.#shapes[t]!, this.#ribbons[t]!];
    // The ground is open; water and railway close it, surfaces and paths open it again, then
    // buildings, tanks and parapets stand on it.
    tile.fill(OPEN);
    for (const s of shapes) if (s.value < SOLID) grid.fillRing(tile, s.ring, s.value, x0, z0);
    for (const r of ribbons) {
      if (r.value < SOLID) grid.fillRibbon(tile, r.line, r.half, r.value, x0, z0, keep(r.value));
    }
    this.#waterUnderDecks(tile, x0, z0, t);
    for (const s of shapes) if (s.value >= SOLID) grid.fillRing(tile, s.ring, s.value, x0, z0);
    for (const r of ribbons) {
      if (r.value >= SOLID) {
        grid.fillRibbon(tile, r.line, r.half, r.value, x0, z0, keep(r.value), r.rightOnly);
      }
    }
    // Paths can spill a little past the map's edge: nothing off the slab is walkable.
    for (let r = 0; r < TILE; r++) {
      const z = z0 + (r + 0.5) * WALK_CELL;
      for (let c = 0; c < TILE; c++) {
        const v = tile[r * TILE + c];
        if (v !== OPEN && v !== STREET) continue;
        if (areaIndex(this.#area, x0 + (c + 0.5) * WALK_CELL, z) < 0) tile[r * TILE + c] = CLOSED;
      }
    }
  }
}
