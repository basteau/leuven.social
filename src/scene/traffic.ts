import { PAVED } from '../data/city.ts';
import type { Surface, Way, WayKind } from '../data/city.ts';
import type { GraphRouter } from '../data/graph-route.ts';
import {
  PAVEMENT,
  alongEdge,
  coreEdges,
  pavementOf,
  roadGraph,
  roadRouter,
  turnBetween,
} from '../data/traffic.ts';
import type { RoadEdge, RoadGraph } from '../data/traffic.ts';
import { BUS, CARS, GUESTS } from './palette.ts';

/**
 * Traffic: cars, buses, bikes and people moving along the streets (src/data/traffic.ts builds
 * the graph). Each vehicle drives the shortest route to a destination it picked (the A* of
 * src/data/graph-route.ts), keeps its distance from the one ahead in its lane (a trimmed
 * intelligent-driver model), slows for the corner it has chosen next and rounds it on a curve,
 * and waits its turn at a junction another is crossing. The fleet keeps to a circle round the
 * view (`focus`), at a density its area deserves. Nothing is simulated off the graph, and a
 * vehicle that drives off the edge of it comes back somewhere in the circle, out of sight.
 * The drawing is vehicles.ts; this file knows nothing of three.js.
 */

export type VehicleKind = 'car' | 'bus' | 'bike' | 'person';
export const VEHICLE_KINDS = ['car', 'bus', 'bike', 'person'] as const;

/** Who shares a lane and a junction with whom: motor vehicles, bikes, people on foot. */
export const CLASS: Record<VehicleKind, 0 | 1 | 2> = { car: 0, bus: 0, bike: 1, person: 2 };
const CLASSES = 3;

export interface Vehicle {
  kind: VehicleKind;
  /** On the streets, or parked out of sight until the view has room for it. */
  active: boolean;
  /** The edge it is on and how far along it (m), its speed (m/s) and the cruise it aims for. */
  edge: number;
  s: number;
  speed: number;
  cruise: number;
  /** The edge it came from (-1: none) and the edge it will take next (-1: a dead end). */
  prev: number;
  next: number;
  /** The turn into the next edge (radians, 0 straight on), and which way (-1 left, 1 right). */
  turn: number;
  signal: -1 | 0 | 1;
  /** The corner behind and the corner ahead: how far from the node the curve starts (m). */
  rIn: number;
  rOut: number;
  /** The edges still to take to its destination, last first; the node it is bound for (-1: none). */
  route: number[];
  goal: number;
  /** Its lane: how far right of the edge's line it keeps (m), behind, here and on the next edge. */
  lanePrev: number;
  lane: number;
  laneNext: number;
  /** Its own place across the lane, -1 to 1: no two walk the same line. */
  jitter: number;
  /** Its paint (a shirt, on a bike or on foot), as sRGB, 0 to 1. */
  paint: [number, number, number];
  /** The heading it is drawn at (radians): eased after the path, so corners aren't instant. */
  yaw: number;
  /** Its brake lights, 0 to 1; its stride or pedal cycle (radians); a blink offset, 0 to 1. */
  brake: number;
  phase: number;
  blink: number;
  /** The junction node it holds (-1: none): nobody else of its class crosses it meanwhile. */
  hold: number;
  /** How long it has stood waiting at a junction (s): past PATIENCE it crosses anyway. */
  wait: number;
}

/**
 * The fleet: the most of each kind there ever are. They keep to the streets round the view
 * (`focus`): as many as its area deserves at the density below, no fewer than the floor, and
 * one that drives off beyond it comes back on a street inside it, out of sight.
 */
export const COUNTS: Record<VehicleKind, number> = { car: 220, bus: 14, bike: 300, person: 300 };
/**
 * Vehicles per km of the ways their class may use within the circle they spawn in (buses per
 * km of main road), so a thin network holds few and a dense one many, rather than a count by
 * area that piles up where there is little street: a quiet hour in Leuven's centre, about a
 * car every 270 m of street and a bike every 125 m of way. And the fewest of each kind, however
 * small the circle.
 */
export const PER_KM: Record<VehicleKind, number> = { car: 3.7, bus: 1.2, bike: 8, person: 8 };
export const FLOOR: Record<VehicleKind, number> = { car: 30, bus: 3, bike: 50, person: 60 };
/**
 * The share of cars bound for the far side of the circle (beyond the view), so most traffic
 * crosses the view and leaves rather than circling inside it.
 */
export const THROUGH_GOALS = 0.7;
/** An appendage of the car network shorter than this (m) is no place to spawn or head for. */
const CORE_LEAST = 1500;
/** No spawning on an edge shorter than this (m): a piece between two junctions is a junction. */
const SPAWN_MIN = 25;
/**
 * The view reaches about one radius up and across and 1.4 to its corners, so spawning keeps
 * this many radii away from the focus (out of sight), on edges within RECYCLE_AT radii, beyond
 * which a vehicle is recycled; destinations lie within the radius, so the traffic drives
 * through the view. The focus is refitted once it moves this far.
 */
const SPAWN_FROM = 1.4;
const RECYCLE_AT = 1.7;
const REFOCUS_AT = 40;
/** Respawns a step, so nothing stalls a frame: the fleet fills in over a second or so. */
const RESPAWN_BUDGET = 12;
/** Steps a fill (after a jump) may spawn in view before it goes back to out of sight. */
const FILL_STEPS = 120;
/** Routes found a step: a search is a fraction of a millisecond, and nobody waits long. */
const ROUTE_BUDGET = 4;
/** Length (m), from bumper to bumper, that the gap to the one ahead is measured from. */
export const LENGTH: Record<VehicleKind, number> = { car: 4.2, bus: 12, bike: 1.8, person: 0.5 };
/** Cruising speed (m/s) by kind of way; 0 where it may not go. */
const CRUISE: Record<VehicleKind, Record<WayKind, number>> = {
  car: { main: 12, street: 8, cycle: 0, pedestrian: 0, path: 0 },
  bus: { main: 10, street: 7, cycle: 0, pedestrian: 0, path: 0 },
  bike: { main: 5, street: 4.5, cycle: 4.5, pedestrian: 3.5, path: 0 },
  person: { main: 1.4, street: 1.4, cycle: 1.3, pedestrian: 1.3, path: 1.3 },
};
/** A car's pace on a living street (m/s): the woonerf's 20 km/h. */
const LIVING_STREET = 5.5;
/** How much slower than its cruise a vehicle goes off the paved surfaces: gravel, earth, grass. */
const OFF_ROAD: Partial<Record<Surface, number>> = { gravel: 0.7, earth: 0.55, grass: 0.5 };
/** Standing gap (m), time headway (s), acceleration and comfortable braking (m/s²). */
const GAP: Record<VehicleKind, number> = { car: 2.5, bus: 4, bike: 1, person: 0.5 };
const HEADWAY = 1.2;
const ACCEL: Record<VehicleKind, number> = { car: 2, bus: 1.2, bike: 1.2, person: 1.5 };
const BRAKE = 3;
/** The speed (m/s) a sharp corner is taken at, and what counts as one (radians). */
const TURN_SPEED: Record<VehicleKind, number> = { car: 3.5, bus: 2.5, bike: 2.5, person: 1.2 };
const SHARP = 0.35;
/** How far before a node the curve round it starts (m), at most; less on short edges. */
const CORNER: Record<VehicleKind, number> = { car: 5, bus: 8, bike: 2.5, person: 1 };
/**
 * How fast the drawn heading may turn (rad/s): a cap on following the path's own tangent,
 * which is smooth (`place`), so it only shows in a hairpin; a bus swings slower than a cyclist.
 */
export const TURN_RATE: Record<VehicleKind, number> = { car: 4, bus: 2.5, bike: 6, person: 8 };
/**
 * Metres per stride (on foot) or pedal turn (on a bike): what one cycle of the legs covers. A
 * person's is a stroll's two steps at the figure's size (a third over life), a bike's a city
 * bike's gearing.
 */
export const STRIDE: Record<VehicleKind, number> = { car: 1, bus: 1, bike: 5, person: 2 };
/** Where the indicators come on before a turn (m), and how far into the junction one may hold. */
const SIGNAL_AT = 30;
const CLAIM_AHEAD = 2;
/**
 * How long a vehicle waits at a junction that doesn't clear (s) before it goes anyway, as a
 * driver does: without it, chains of claims round a block lock the whole centre up in minutes.
 */
export const PATIENCE = 6;
/** Straight on is this many times as likely as a turn, when there is no route to follow. */
const STRAIGHT_WEIGHT = 3;
/** Spawning keeps this clear (m) of anyone else of the class on the edge. */
const SPAWN_GAP: Record<VehicleKind, number> = { car: 12, bus: 16, bike: 6, person: 3 };
/** Routes go at most this far round the focus (m), on top of its radius. */
const ROUTE_REACH = 400;

export const motor = (kind: VehicleKind) => CLASS[kind] === 0;

/** A small deterministic generator, so tests and a reload see the same traffic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const srgb = (hex: number): [number, number, number] => [
  ((hex >> 16) & 255) / 255,
  ((hex >> 8) & 255) / 255,
  (hex & 255) / 255,
];

/** Half a car's width and a bike's, with a little air (m): whether two lanes overlap. */
const CAR_HALF = 0.95;
const BIKE_HALF = 0.35;
/** People keep this far (m) from the kerb and from the facade on a pavement. */
const PAVEMENT_MARGIN = 0.45;
/** The bake probes a side this far (m) at most: a kerb found there is no kerb. */
const KERB_LIMIT = 11.5;

/**
 * The lane a kind keeps right of a way's line (m), from the way's measured sides. Where the
 * GRB cut a kerb along it: cars in the carriageway's right half (on its line on a one-way
 * street), bikes by the kerb, and people on the pavement beyond it, each at a place of their
 * own across it, or on the left pavement (a negative lane) when the right has none. Where no
 * kerb was cut (a street without one, a square's edge) the ground is shared: cars near the
 * middle, bikes further right, people by the facade, inside the open ground. On a cycle track
 * bikes keep to its right half and people walk beside it; on a pedestrian street people spread
 * across it and bikes thread the middle; on a path everyone keeps near its line. `jitter` (-1 to
 * 1) is each one's own place across its lane.
 */
export function laneFor(
  kind: VehicleKind,
  e: RoadEdge,
  twoWay: boolean,
  jitter: number,
  keepLeft = false,
): number {
  const { right, left } = e;
  const w = right.edge;
  // A kerb out at the probe's limit is a square's or a verge's edge, not a kerb: shared ground.
  const kerb = right.kerb >= KERB_LIMIT ? 0 : right.kerb;
  switch (kind) {
    case 'car':
    case 'bus':
      // Never nearer the line than a metre, so oncoming cars on a narrow street pass clear.
      if (kerb > 0)
        return twoWay ? Math.min(1.8, Math.max(1, kerb * 0.5)) : Math.min(0.4, kerb * 0.12);
      return twoWay ? Math.min(1.7, Math.max(1, w * 0.45)) : Math.min(0.3, w * 0.1);
    case 'bike':
      if (e.kind === 'cycle') {
        return (twoWay ? Math.min(0.8, (kerb || w) * 0.3) : 0) + 0.2 * jitter;
      }
      if (e.kind === 'pedestrian') return Math.min(1.5, w * 0.3) + 0.3 * jitter;
      if (kerb > 0) return Math.min(4.5, Math.max(0.3, kerb - 0.7)) + 0.2 * jitter;
      return (twoWay ? Math.min(2.8, w * 0.7) : Math.min(1.5, w * 0.5)) + 0.25 * jitter;
    default: {
      if (e.kind === 'path') return 0.4 * jitter;
      if (e.kind === 'pedestrian') return Math.min(6, w) * 0.5 * jitter;
      const across = (side: typeof right, pavement: number) =>
        side.kerb + PAVEMENT_MARGIN + (pavement - 2 * PAVEMENT_MARGIN) * (0.5 + 0.5 * jitter);
      const onRight = pavementOf(right);
      const onLeft = pavementOf(left);
      // Someone on the left pavement stays on it while it goes on, rather than crossing back.
      if (keepLeft && onLeft >= 2 * PAVEMENT_MARGIN)
        return -across(left, Math.max(onLeft, PAVEMENT));
      if (onRight >= PAVEMENT) return across(right, onRight);
      if (onLeft >= PAVEMENT) return -across(left, onLeft);
      // Shared ground, or a kerb at the facade: by the facade, never through it.
      return Math.max(0.3, Math.min(4, w - 1) + 0.4 * jitter);
    }
  }
}

/**
 * Whether cars and bikes share a lane on an edge: the car's lane reaches over the bike's, as
 * on a narrow street, so a car queues behind a cyclist rather than driving through it.
 */
export function sharesLane(e: RoadEdge, carsTwoWay: boolean, bikesTwoWay: boolean): boolean {
  if (!e.cars || !e.bikes) return false;
  return (
    laneFor('car', e, carsTwoWay, 0) + CAR_HALF > laneFor('bike', e, bikesTwoWay, 0) - BIKE_HALF
  );
}

/**
 * What a metre of each kind of way costs each class to route along, over its length: cars
 * keep to the through roads, bikes to the cycle tracks and quiet streets, people to the
 * paths, pedestrian streets and pavements. Never under 1, so the straight-line guess the A*
 * takes stays a lower bound.
 */
export const ROUTE_COST: Record<0 | 1 | 2, Record<WayKind, number>> = {
  0: { main: 1, street: 1.3, cycle: 1, pedestrian: 1, path: 1 },
  1: { main: 1.4, street: 1.15, cycle: 1, pedestrian: 1.3, path: 1 },
  2: { main: 1.6, street: 1.1, cycle: 1.2, pedestrian: 1, path: 1 },
};
/** A street with no pavement on either side costs someone on foot this much more a metre. */
export const NO_PAVEMENT = 1.5;
/** What a car pays a metre to drive a destination-only street, or a living street. */
export const NO_THROUGH = 5;
export const LIVING_COST = 2.5;

/**
 * What a metre of an edge costs a class: its kind's cost (ROUTE_COST), and for someone on foot
 * on a street or a main road with no pavement on either side (the kerb at the facade, or no
 * kerb cut at all: shared ground), NO_PAVEMENT times more, so a way round by a pavement wins.
 */
export function routeCost(cls: 0 | 1 | 2, e: RoadEdge): number {
  const cost = ROUTE_COST[cls][e.kind];
  // A car has no business cutting through a living street, let alone a street for those who
  // live there: it goes round unless that is where it is bound.
  if (cls === 0) return cost * (e.through ? 1 : NO_THROUGH) * (e.minor ? LIVING_COST : 1);
  if (cls !== 2 || (e.kind !== 'street' && e.kind !== 'main')) return cost;
  const paved = pavementOf(e.right) >= PAVEMENT || pavementOf(e.left) >= PAVEMENT;
  return paved ? cost : cost * NO_PAVEMENT;
}

/** A pool of edges to spawn on, each with its cumulative length, for picking one by length. */
interface Pool {
  edges: number[];
  cum: number[];
}

export class Traffic {
  readonly graph: RoadGraph;
  readonly vehicles: Vehicle[] = [];
  /** A router per class, each with its own costs. */
  readonly #routers: GraphRouter[];
  /** Which edges each class may take. */
  readonly #allowed: ((edge: number) => boolean)[];
  /**
   * The edges each class may use anywhere, those near the focus (destinations), those out to
   * the recycling radius (the fill, and what the circle holds), and the ring between the view
   * and that radius (spawning, out of sight).
   */
  readonly #pools: Pool[];
  #near: Pool[] | null = null;
  #wide: Pool[] | null = null;
  #ring: Pool[] | null = null;
  /** Whether each edge has a twin the class may use the other way: where the lane is kept right. */
  readonly #twoWay: Uint8Array;
  /** Edges where bikes queue with the cars (their lanes overlap), in the cars' bucket. */
  readonly #shared: Uint8Array;
  /** Each edge's twin, the same way run the other way (-1: none): where a U-turn would go. */
  readonly #twin: Int32Array;
  readonly #random: () => number;
  /** Vehicles sorted by edge, class and distance along, rebuilt each step for the leader search. */
  readonly #order: number[] = [];
  /** The first vehicle of each class on each edge, after a sort (-1: none). */
  readonly #first: Int32Array;
  /** Who holds each junction for each class (-1: nobody), and the edge they came by. */
  readonly #claim: Int32Array;
  readonly #claimFrom: Int32Array;
  /**
   * Which nodes are junctions for each class: where three or more of its ways meet. Where only
   * a path joins a street, or a way is merely split, a car has nothing to wait for.
   */
  readonly #junction: Uint8Array;
  /** Where the view looks and how far round it the traffic keeps. */
  readonly #focus = { x: Number.NaN, z: Number.NaN, radius: 0 };
  readonly #mid: Float32Array;
  #want: Record<VehicleKind, number> = { ...COUNTS };
  /** Where the round-robin scans for recycling and routing got to. */
  #scan = 0;
  #routeScan = 0;
  /** Filling the circle after a jump (or at the start): spawns land anywhere in it, in view too. */
  #filling = FILL_STEPS;

  constructor(ways: readonly Way[], seed = 1, counts: Record<VehicleKind, number> = COUNTS) {
    this.graph = roadGraph(ways);
    const { edges, nodes } = this.graph;
    this.#routers = [0, 1, 2].map((cls) =>
      roadRouter(this.graph, (i) => routeCost(cls as 0 | 1 | 2, edges[i]!)),
    );
    this.#random = mulberry32(seed);
    this.#allowed = [(i) => edges[i]!.cars, (i) => edges[i]!.bikes, (i) => edges[i]!.feet];
    // A twin running the other way, for each class: the way is two-way for it.
    const byEnds = new Map(edges.map((e, i) => [`${e.from}>${e.to}`, i]));
    this.#twoWay = new Uint8Array(edges.length);
    this.#twin = new Int32Array(edges.length).fill(-1);
    for (const [i, e] of edges.entries()) {
      const twin = byEnds.get(`${e.to}>${e.from}`);
      if (twin === undefined) continue;
      this.#twin[i] = twin;
      for (let cls = 0; cls < CLASSES; cls++) {
        if (this.#allowed[cls]!(twin)) this.#twoWay[i]! |= 1 << cls;
      }
    }
    this.#shared = new Uint8Array(edges.length);
    for (const [i, e] of edges.entries()) {
      const two = this.#twoWay[i]!;
      if (sharesLane(e, (two & 1) !== 0, (two & 2) !== 0)) this.#shared[i] = 1;
    }
    // Cars spawn on, and head for, the core of their network only (coreEdges): not an abbey's
    // lanes, a stub to the map's edge, or a street for those who live there.
    const core = coreEdges(this.graph, (i) => edges[i]!.cars && edges[i]!.through, CORE_LEAST);
    this.#pools = this.#allowed.map((allowed, cls) => {
      const list: number[] = [];
      const cum: number[] = [];
      let total = 0;
      for (const [i, e] of edges.entries()) {
        // Nobody spawns on, or heads for, an edge that leads nowhere but back the way it came
        // (a cul-de-sac, the map's edge): they would turn round or drive off at once.
        const onward = nodes[e.to]!.out.some((j) => j !== this.#twin[i] && allowed(j));
        if (!allowed(i) || !onward || (cls === 0 && !core[i])) continue;
        list.push(i);
        cum.push((total += e.length));
      }
      return { edges: list, cum };
    });
    this.#first = new Int32Array(edges.length * CLASSES);
    this.#claim = new Int32Array(nodes.length * CLASSES).fill(-1);
    this.#claimFrom = new Int32Array(nodes.length * CLASSES).fill(-1);
    this.#junction = new Uint8Array(nodes.length * CLASSES);
    const neighbours: Set<number>[] = Array.from(
      { length: nodes.length * CLASSES },
      () => new Set(),
    );
    for (const [i, e] of edges.entries()) {
      for (let cls = 0; cls < CLASSES; cls++) {
        if (!this.#allowed[cls]!(i)) continue;
        neighbours[e.from * CLASSES + cls]!.add(e.to);
        neighbours[e.to * CLASSES + cls]!.add(e.from);
      }
    }
    for (const [k, set] of neighbours.entries()) this.#junction[k] = set.size >= 3 ? 1 : 0;
    this.#mid = new Float32Array(edges.length * 2);
    const mid: [number, number, number, number] = [0, 0, 0, 0];
    for (const [i, e] of edges.entries()) {
      alongEdge(e, e.length / 2, mid);
      [this.#mid[i * 2], this.#mid[i * 2 + 1]] = [mid[0], mid[1]];
    }
    // The fleet starts parked: it comes out a few a step round the first focus, so no frame
    // pays for placing it all at once.
    for (const kind of VEHICLE_KINDS) {
      for (let i = 0; i < counts[kind]; i++) {
        this.vehicles.push({
          kind,
          active: false,
          edge: 0,
          s: 0,
          speed: 0,
          cruise: 1,
          prev: -1,
          next: -1,
          turn: 0,
          signal: 0,
          rIn: 0,
          rOut: 0,
          route: [],
          goal: -1,
          lanePrev: 0,
          lane: 0,
          laneNext: 0,
          jitter: this.#random() * 2 - 1,
          paint: this.#paint(kind),
          yaw: 0,
          brake: 0,
          phase: this.#random() * Math.PI * 2,
          blink: this.#random(),
          hold: -1,
          wait: 0,
        });
      }
    }
    for (let i = 0; i < this.vehicles.length; i++) this.#order.push(i);
  }

  /**
   * Keeps the traffic round a spot: the edges within `radius` of it are where vehicles spawn
   * and head for, and how many are out is what that circle's area deserves. Called with the
   * view's target every frame; it does the work only once the spot has moved a few dozen
   * metres or the radius has changed. A jump (a reset, a flight) parks the whole fleet, which
   * then fills the new circle over the next second.
   */
  focus(x: number, z: number, radius: number): void {
    const f = this.#focus;
    const moved = Math.hypot(x - f.x, z - f.z);
    if (moved < REFOCUS_AT && Math.abs(radius - f.radius) < 0.15 * f.radius) return;
    const jump = !(moved < 2 * f.radius);
    [f.x, f.z, f.radius] = [x, z, radius];
    const within = (i: number, reach: number) =>
      Math.hypot(this.#mid[i * 2]! - x, this.#mid[i * 2 + 1]! - z) <= reach;
    const inside = (reach: number, beyond = 0) =>
      this.#pools.map((pool) => {
        const edges: number[] = [];
        const cum: number[] = [];
        let total = 0;
        for (const [k, i] of pool.edges.entries()) {
          if (!within(i, reach) || (beyond > 0 && within(i, beyond))) continue;
          edges.push(i);
          cum.push((total += pool.cum[k]! - (pool.cum[k - 1] ?? 0)));
        }
        return { edges, cum };
      });
    this.#near = inside(radius);
    this.#wide = inside(RECYCLE_AT * radius);
    this.#ring = inside(RECYCLE_AT * radius, SPAWN_FROM * radius);
    // The fleet fills the circle it spawns in, by how much way the circle holds for each.
    const { edges } = this.graph;
    const wide = this.#wide;
    const km = (cls: number, kind?: WayKind) =>
      wide[cls]!.edges.reduce(
        (sum, i) => sum + (kind && edges[i]!.kind !== kind ? 0 : edges[i]!.length),
        0,
      ) / 1000;
    const hold: Record<VehicleKind, number> = {
      car: km(0),
      bus: km(0, 'main'),
      bike: km(1),
      person: km(2),
    };
    for (const kind of VEHICLE_KINDS) {
      this.#want[kind] = Math.min(
        COUNTS[kind],
        Math.max(FLOOR[kind], Math.round(PER_KM[kind] * hold[kind])),
      );
    }
    if (jump) {
      for (const v of this.vehicles) this.#park(v);
      this.#filling = FILL_STEPS;
    }
  }

  /** How far a spot is from the focus, or nothing without one. */
  #fromFocus(x: number, z: number): number {
    return Number.isNaN(this.#focus.x) ? 0 : Math.hypot(x - this.#focus.x, z - this.#focus.z);
  }

  /** Takes a vehicle off the streets, letting go of any junction it holds. */
  #park(v: Vehicle): void {
    this.#release(v);
    v.active = false;
    v.route.length = 0;
    v.goal = -1;
  }

  /** A random edge of a pool, by length. */
  #pick(pool: Pool): number {
    const total = pool.cum.at(-1) ?? 0;
    const at = this.#random() * total;
    let lo = 0;
    let hi = pool.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pool.cum[mid]! < at) lo = mid + 1;
      else hi = mid;
    }
    return pool.edges[lo]!;
  }

  /**
   * Puts a parked vehicle on a random edge of its class, by length, near the focus (where there
   * is one) and out of its view (unless `anywhere`), at a spot clear of the others. Whether it
   * found one.
   */
  #spawn(v: Vehicle, anywhere = false): boolean {
    const cls = CLASS[v.kind];
    // The ring out of sight; filling after a jump, or where the ring is off the map, the
    // circle; never in sight otherwise: a spot not found this step is found another.
    const ring = this.#ring?.[cls];
    const pool = anywhere || !ring?.edges.length ? this.#wide?.[cls] : ring;
    const from = pool?.edges.length ? pool : this.#pools[cls]!;
    if (!from.edges.length) return false;
    const spot: [number, number, number, number] = [0, 0, 0, 0];
    for (let tries = 0; tries < 12; tries++) {
      const edge = this.#pick(from);
      const e = this.graph.edges[edge]!;
      // A fill lands in the middle of a longer edge, spread out; a spawn anywhere along it.
      if (e.length < (anywhere ? 30 : SPAWN_MIN)) continue;
      const s = e.length * (anywhere ? 0.3 + 0.4 * this.#random() : 0.1 + 0.8 * this.#random());
      alongEdge(e, s, spot);
      const { radius } = this.#focus;
      const away = this.#fromFocus(spot[0], spot[1]);
      // Inside the circle it is recycled beyond, and out of the view where the ring reaches.
      const inside = away <= RECYCLE_AT * radius;
      const hidden = inside && (from !== ring || away >= SPAWN_FROM * radius);
      if (radius > 0 && !hidden) continue;
      const bucket = this.#bucket(v, edge);
      const clear = this.vehicles.every(
        (o) =>
          !o.active ||
          o.edge !== edge ||
          this.#bucket(o, edge) !== bucket ||
          Math.abs(o.s - s) > SPAWN_GAP[v.kind],
      );
      if (!clear) continue;
      this.#release(v);
      v.active = true;
      v.edge = edge;
      v.prev = -1;
      v.s = s;
      v.cruise = this.#cruise(v.kind, e);
      v.speed = v.cruise * (0.5 + 0.5 * this.#random());
      v.lane = this.#lane(v, edge);
      v.lanePrev = v.lane;
      v.rIn = 0;
      v.route.length = 0;
      v.goal = -1;
      v.brake = 0;
      v.signal = 0;
      v.wait = 0;
      this.#choose(v);
      // Facing the way it goes, from the start.
      alongEdge(e, s, spot);
      v.yaw = Math.atan2(-spot[3], spot[2]);
      return true;
    }
    return false;
  }

  #paint(kind: VehicleKind): [number, number, number] {
    const list = kind === 'car' ? CARS : kind === 'bus' ? [BUS.body] : GUESTS.shirts;
    return srgb(list[Math.floor(this.#random() * list.length)]!);
  }

  /** The cruise on an edge, each driver a little faster or slower, and slower off the paving. */
  #cruise(kind: VehicleKind, e: RoadEdge): number {
    const pace = PAVED.has(e.surface) ? 1 : (OFF_ROAD[e.surface] ?? 0.6);
    // A living street is walked through at 20 km/h.
    const calm = e.minor && motor(kind) ? LIVING_STREET / CRUISE[kind].street : 1;
    return CRUISE[kind][e.kind] * pace * calm * (0.9 + 0.2 * this.#random());
  }

  #lane(v: Vehicle, edge: number): number {
    const e = this.graph.edges[edge]!;
    const twoWay = (this.#twoWay[edge]! & (1 << CLASS[v.kind])) !== 0;
    return laneFor(v.kind, e, twoWay, v.jitter, v.lane < 0);
  }

  /**
   * How far before a node the curve between two edges starts, and after it ends: the kind's
   * corner, longer by what its lane needs on the inside of the turn so the offset path never
   * loops back (`cornerAt`), and by a lane change between the edges, within what the edges'
   * end segments allow, so no bend of theirs lies inside the curve.
   */
  #corner(v: Vehicle, a: RoadEdge, b: RoadEdge, la: number, lb: number): number {
    const n = a.cum.length;
    const first = b.cum[1]! - b.cum[0]!;
    const last = a.cum[n - 1]! - a.cum[n - 2]!;
    return Math.min(legFor(CORNER[v.kind], turnBetween(a, b), la, lb), 0.45 * first, 0.45 * last);
  }

  /**
   * Finds a vehicle its way: a destination among the edges near the focus and the shortest
   * route there for its class that doesn't start by turning back, or nothing when none is
   * within reach (it then turns at random).
   */
  #route(v: Vehicle): void {
    const cls = CLASS[v.kind];
    const pool = this.#near?.[cls]!.edges.length ? this.#near[cls]! : this.#pools[cls]!;
    if (!pool.edges.length) return;
    const { edges } = this.graph;
    const e = edges[v.edge]!;
    // Into the corner ahead already, the edge chosen is kept: the route starts past it.
    const committed = v.next >= 0 && v.s > e.length - v.rOut - CLAIM_AHEAD;
    const on = committed ? v.next : v.edge;
    const from = edges[on]!.to;
    // Most cars are bound beyond the view, so they cross it and leave rather than circle in it.
    const ring = this.#ring?.[cls];
    const far = cls === 0 && ring?.edges.length && this.#random() < THROUGH_GOALS;
    const goal = edges[this.#pick(far ? ring : pool)]!.to;
    if (goal === from) return;
    const most = this.#focus.radius > 0 ? 2 * this.#focus.radius + ROUTE_REACH : Infinity;
    // Never back the way it came: a goal behind it is reached round the block, or not at all.
    const back = this.#twin[on]!;
    const allowed = this.#allowed[cls]!;
    const route = this.#routers[cls]!.route(from, goal, (i) => i !== back && allowed(i), most);
    if (!route) return;
    v.goal = goal;
    v.route = route.toReversed();
    // Whatever it had chosen for the node ahead, the route decides now.
    if (!committed) this.#choose(v);
  }

  /**
   * Picks where a vehicle goes after its edge: the next edge of its route, or without one
   * straight on, mostly, and never back unless it must. Sets the turn, the corner and the lane
   * on the next edge.
   */
  #choose(v: Vehicle): void {
    const { edges, nodes } = this.graph;
    const e = edges[v.edge]!;
    let next = -1;
    while (v.route.length) {
      const candidate = v.route.pop()!;
      if (edges[candidate]!.from === e.to) {
        next = candidate;
        break;
      }
      // The route no longer starts here (a respawn, a detour): drop it and ask for another.
      v.route.length = 0;
      v.goal = -1;
    }
    if (next < 0) {
      const may = this.#allowed[CLASS[v.kind]]!;
      const allowed = nodes[e.to]!.out.filter(may);
      const onward = allowed.filter((i) => edges[i]!.to !== e.from);
      // Not into a stub that leads nowhere but back, while there is anywhere else to go.
      const through = onward.filter((i) =>
        nodes[edges[i]!.to]!.out.some((j) => j !== this.#twin[i] && may(j)),
      );
      const options = through.length ? through : onward.length ? onward : allowed;
      if (options.length) {
        const turns = options.map((i) => turnBetween(e, edges[i]!));
        const weights = turns.map((t) => (t < SHARP ? STRAIGHT_WEIGHT : 1));
        let pick = this.#random() * weights.reduce((a, b) => a + b, 0);
        next = options.at(-1)!;
        for (const [i, w] of weights.entries()) {
          if ((pick -= w) <= 0) {
            next = options[i]!;
            break;
          }
        }
      }
    }
    v.next = next;
    if (next < 0) {
      v.turn = 0;
      v.rOut = 0;
      v.laneNext = v.lane;
      return;
    }
    const onto = edges[next]!;
    v.turn = turnBetween(e, onto);
    v.laneNext = this.#lane(v, next);
    v.rOut = this.#corner(v, e, onto, v.lane, v.laneNext);
  }

  /** Sorts the vehicles so each one's leader is the next in its edge and class. */
  #sort(): void {
    const { vehicles } = this;
    // Parked vehicles sort last, past every edge, and claim no place on one.
    const key = (i: number) => {
      const v = vehicles[i]!;
      return v.active ? v.edge * CLASSES + this.#bucket(v, v.edge) : this.#first.length;
    };
    this.#order.sort((a, b) => key(a) - key(b) || vehicles[a]!.s - vehicles[b]!.s);
    this.#first.fill(-1);
    for (let i = this.#order.length - 1; i >= 0; i--) {
      const k = key(this.#order[i]!);
      if (k < this.#first.length) this.#first[k] = this.#order[i]!;
    }
  }

  /**
   * Keeps the fleet round the focus, a few vehicles a step: one that has driven out beyond it
   * comes back on a street inside it, out of sight; one parked comes out while its kind is
   * under what the view deserves; one over it is parked once it has driven out.
   */
  #recycle(): void {
    const { vehicles } = this;
    const { radius } = this.#focus;
    if (!(radius > 0) || !vehicles.length) return;
    const out: Record<VehicleKind, number> = { car: 0, bus: 0, bike: 0, person: 0 };
    for (const v of vehicles) if (v.active) out[v.kind]++;
    if (this.#filling > 0) this.#filling--;
    const spot: [number, number, number, number] = [0, 0, 0, 0];
    for (let n = 0, done = 0; n < vehicles.length && done < RESPAWN_BUDGET; n++) {
      const v = vehicles[(this.#scan = (this.#scan + 1) % vehicles.length)]!;
      const want = this.#want[v.kind];
      if (v.active) {
        this.place(v, spot);
        if (this.#fromFocus(spot[0], spot[1]) <= RECYCLE_AT * radius) continue;
        // Over what the view deserves, or nowhere to come back in just now: parked till there is.
        if (out[v.kind] > want || !this.#spawn(v)) {
          this.#park(v);
          out[v.kind]--;
        }
        done++;
      } else if (out[v.kind] < want) {
        if (this.#spawn(v, this.#filling > 0)) out[v.kind]++;
        done++;
      }
    }
  }

  /** Finds routes for a few of the vehicles without one, round-robin. */
  #plan(): void {
    const { vehicles } = this;
    for (let n = 0, done = 0; n < vehicles.length && done < ROUTE_BUDGET; n++) {
      const v = vehicles[(this.#routeScan = (this.#routeScan + 1) % vehicles.length)]!;
      if (!v.active || v.goal >= 0) continue;
      this.#route(v);
      done++;
    }
  }

  /** The junction claim slot of a node for a class. */
  #slot(node: number, cls: number): number {
    return node * CLASSES + cls;
  }

  /** Whose queue a vehicle joins on an edge: its class's, or the cars' for a bike on a shared lane. */
  #bucket(v: Vehicle, edge: number): number {
    const cls = CLASS[v.kind];
    return cls === 1 && this.#shared[edge] ? 0 : cls;
  }

  /** Lets go of the junction a vehicle holds, if any. */
  #release(v: Vehicle): void {
    if (v.hold < 0) return;
    const slot = this.#slot(v.hold, CLASS[v.kind]);
    if (this.#claim[slot] === this.vehicles.indexOf(v)) this.#claim[slot] = -1;
    v.hold = -1;
  }

  /**
   * Whether a vehicle about to cross the node ahead may: it is no junction for its class, it
   * holds it already, nobody of its class does, the holder came the same way (a queue crossing
   * together), the holder has gone (parked, or driven on without letting go), or it has waited
   * its PATIENCE out. Takes the junction when it may, if there is room beyond it (or it has
   * waited); people on foot cross freely.
   */
  #mayCross(i: number, v: Vehicle, e: RoadEdge, roomBeyond: boolean): boolean {
    const cls = CLASS[v.kind];
    if (cls === 2) return true;
    const node = e.to;
    const slot = this.#slot(node, cls);
    if (!this.#junction[slot]) return true;
    const holder = this.#claim[slot]!;
    if (holder === i) return true;
    const patient = v.wait < PATIENCE;
    if (holder >= 0 && patient) {
      const h = this.vehicles[holder]!;
      const stale = !h.active || h.hold !== node;
      if (!stale && this.#claimFrom[slot] === v.edge) return true;
      if (!stale) return false;
    }
    if (!roomBeyond && patient) return false;
    this.#release(v);
    this.#claim[slot] = i;
    this.#claimFrom[slot] = v.edge;
    v.hold = node;
    return true;
  }

  /** Advances every vehicle by `dt` seconds (clamped by the caller to a few hundredths). */
  step(dt: number): void {
    const { vehicles } = this;
    const { edges } = this.graph;
    this.#recycle();
    this.#plan();
    this.#sort();
    const order = this.#order;
    for (let k = 0; k < order.length; k++) {
      const i = order[k]!;
      const v = vehicles[i]!;
      if (!v.active) break; // the parked ones sort last
      const e = edges[v.edge]!;
      const bucket = this.#bucket(v, v.edge);
      // The one ahead: next in the order on the same edge and queue, else first on the next edge.
      let gap = Infinity;
      let ahead = 0;
      let gapBeyond = Infinity;
      const after = order[k + 1];
      const peer = after === undefined ? undefined : vehicles[after];
      if (peer && peer.edge === v.edge && this.#bucket(peer, v.edge) === bucket) {
        gap = peer.s - LENGTH[peer.kind] / 2 - (v.s + LENGTH[v.kind] / 2);
        ahead = peer.speed;
      }
      if (v.next >= 0) {
        const first = this.#first[this.#slot(v.next, this.#bucket(v, v.next))]!;
        if (first >= 0) {
          const o = vehicles[first]!;
          gapBeyond = e.length - v.s + o.s - LENGTH[o.kind] / 2 - LENGTH[v.kind] / 2;
          if (gap === Infinity) {
            gap = gapBeyond;
            ahead = o.speed;
          }
        }
      }
      // The intelligent driver model: free acceleration towards the cruise, held back by the
      // gap to the one ahead; stopped dead on a gap that has closed.
      const a = ACCEL[v.kind];
      const want =
        GAP[v.kind] +
        v.speed * HEADWAY +
        (v.speed * (v.speed - ahead)) / (2 * Math.sqrt(a * BRAKE));
      let acc =
        a *
        (1 -
          (v.speed / Math.max(v.cruise, 0.1)) ** 4 -
          (gap < Infinity ? (Math.max(want, 0) / Math.max(gap, 0.1)) ** 2 : 0));
      if (gap < 0.3) acc = -BRAKE * 3;
      // Slow for the corner ahead, or the dead end: never faster than it can brake from.
      const end = v.next < 0 ? 0 : v.turn > SHARP ? TURN_SPEED[v.kind] : v.cruise;
      const room = Math.max(0, e.length - v.s);
      let cap = Math.sqrt(end * end + 2 * BRAKE * room);
      // The junction: take it if free and there is room beyond, else stop before it.
      const toLine = e.length - v.rOut - CLAIM_AHEAD - v.s;
      if (v.next >= 0 && toLine < v.speed * 1.5 + 2) {
        const roomBeyond = gapBeyond > LENGTH[v.kind] + GAP[v.kind];
        if (!this.#mayCross(i, v, e, roomBeyond)) {
          cap = Math.min(cap, Math.sqrt(2 * BRAKE * Math.max(0, toLine)));
          if (v.speed < 0.2) v.wait += dt;
        }
      }
      if (v.speed > 0.5) v.wait = 0;
      // Indicators come on for a turn ahead, and the brake lights with the braking.
      v.signal = room < SIGNAL_AT && v.turn > SHARP && v.next >= 0 ? this.#side(e, v.next) : 0;
      const braking = acc < -0.8 || v.speed > cap + 0.1;
      v.brake = braking ? 1 : Math.max(0, v.brake - 4 * dt);
      v.speed = Math.max(0, Math.min(v.speed + acc * dt, cap));
      v.s += v.speed * dt;
      v.phase += (v.speed * dt * Math.PI * 2) / STRIDE[v.kind];
      // Past the corner behind, the junction is free for the next one.
      if (v.hold >= 0 && v.hold !== e.to && v.s > v.rIn + 0.5) this.#release(v);
      if (v.s >= e.length) {
        if (v.next < 0) {
          // A dead end: back in somewhere else, out of sight, or where there is a way back (a
          // cul-de-sac, the map's edge) and the view would see it go, turned round instead.
          const back = this.#twin[v.edge]!;
          this.place(v, PLACED);
          const seen = this.#fromFocus(PLACED[0], PLACED[1]) < SPAWN_FROM * this.#focus.radius;
          if (!(seen && back >= 0 && this.#allowed[CLASS[v.kind]]!(back))) {
            if (!this.#spawn(v)) v.s = e.length;
            continue;
          }
          v.next = back;
          v.turn = Math.PI;
          v.laneNext = this.#lane(v, back);
          v.rOut = this.#corner(v, e, edges[back]!, v.lane, v.laneNext);
          v.s = Math.min(v.s, e.length);
        }
        v.s -= e.length;
        v.prev = v.edge;
        v.edge = v.next;
        v.rIn = v.rOut;
        v.lanePrev = v.lane;
        v.lane = v.laneNext;
        const onto = edges[v.edge]!;
        v.cruise = this.#cruise(v.kind, onto);
        v.speed = Math.min(v.speed, v.cruise);
        if (onto.to === v.goal) v.goal = -1; // arriving: a new destination next
        this.#choose(v);
      }
    }
  }

  /** Which way the turn from an edge into another goes: -1 left, 1 right (0 straight). */
  #side(e: RoadEdge, next: number): -1 | 0 | 1 {
    const onto = this.graph.edges[next]!;
    const n = e.points.length;
    const [ax, az] = [e.points[n - 2]! - e.points[n - 4]!, e.points[n - 1]! - e.points[n - 3]!];
    const [bx, bz] = [onto.points[2]! - onto.points[0]!, onto.points[3]! - onto.points[1]!];
    // In (x east, z south) a clockwise turn (to the right) has a positive cross product.
    const cross = ax * bz - az * bx;
    return cross > 1e-6 ? 1 : cross < -1e-6 ? -1 : 0;
  }

  /**
   * Where a vehicle is: its spot, in its lane, and the way it heads (unit), both from the path
   * it is actually drawn along. Straight stretches are the edge's line pushed out by the lane.
   * Round a node it follows a curve from the corner's start on the edge behind to the corner's
   * end on the edge ahead, and round a bend inside an edge a fillet the same way, each built in
   * lane space (`cornerAt`), so an offset path never jumps, loops back or runs crabwise.
   */
  place(
    v: Vehicle,
    out: [number, number, number, number] = [0, 0, 0, 0],
  ): [number, number, number, number] {
    const { edges, nodes } = this.graph;
    const e = edges[v.edge]!;
    const { points, cum } = e;
    const n = cum.length;
    if (v.rIn > 0 && v.s < v.rIn && v.prev >= 0) {
      // The second half of the corner behind.
      const a = edges[v.prev]!;
      const node = nodes[e.from]!;
      const [ax, az] = segmentDir(a, a.cum.length - 2);
      const [bx, bz] = segmentDir(e, 0);
      const t = 0.5 + v.s / (2 * v.rIn);
      return cornerAt(node.x, node.z, ax, az, bx, bz, v.rIn, v.lanePrev, v.lane, t, out);
    }
    if (v.rOut > 0 && v.s > e.length - v.rOut && v.next >= 0) {
      // The first half of the corner ahead.
      const b = edges[v.next]!;
      const node = nodes[e.to]!;
      const [ax, az] = segmentDir(e, n - 2);
      const [bx, bz] = segmentDir(b, 0);
      const t = (v.s - (e.length - v.rOut)) / (2 * v.rOut);
      return cornerAt(node.x, node.z, ax, az, bx, bz, v.rOut, v.lane, v.laneNext, t, out);
    }
    // On a segment: a fillet round the bend behind or ahead, else straight on, offset.
    const k = segmentAt(e, v.s);
    for (const [j, behind] of [
      [k, true],
      [k + 1, false],
    ] as const) {
      if (j < 1 || j > n - 2) continue;
      const leg = this.#fillet(v, e, j);
      const along = behind ? v.s - cum[j]! : cum[j]! - v.s;
      if (!(leg > 0) || along >= leg) continue;
      const [ax, az] = segmentDir(e, j - 1);
      const [bx, bz] = segmentDir(e, j);
      const t = behind ? 0.5 + along / (2 * leg) : 0.5 - along / (2 * leg);
      return cornerAt(
        points[j * 2]!,
        points[j * 2 + 1]!,
        ax,
        az,
        bx,
        bz,
        leg,
        v.lane,
        v.lane,
        t,
        out,
      );
    }
    alongEdge(e, v.s, out);
    const [dx, dz] = [out[2], out[3]];
    // Right-hand traffic: right of the heading in (x east, z south) is (-dz, dx).
    out[0] += -dz * v.lane;
    out[1] += dx * v.lane;
    return out;
  }

  /** How far either side of an edge's bend at point `j` a vehicle's fillet reaches (m), or 0 straight on. */
  #fillet(v: Vehicle, e: RoadEdge, j: number): number {
    const [ax, az] = segmentDir(e, j - 1);
    const [bx, bz] = segmentDir(e, j);
    const turn = Math.acos(Math.min(1, Math.max(-1, ax * bx + az * bz)));
    if (turn < BEND) return 0;
    const before = e.cum[j]! - e.cum[j - 1]!;
    const after = e.cum[j + 1]! - e.cum[j]!;
    return Math.min(legFor(CORNER[v.kind], turn, v.lane, v.lane), 0.45 * before, 0.45 * after);
  }
}

/** A bend of less than this (radians) inside an edge is driven straight through. */
const BEND = 0.05;
/** Scratch for a vehicle's spot. */
const PLACED: [number, number, number, number] = [0, 0, 0, 0];

/** The unit direction of an edge's segment `k` (from its point k to k + 1). */
function segmentDir(e: RoadEdge, k: number): [number, number] {
  const { points } = e;
  const [dx, dz] = [points[k * 2 + 2]! - points[k * 2]!, points[k * 2 + 3]! - points[k * 2 + 1]!];
  const len = Math.hypot(dx, dz) || 1;
  return [dx / len, dz / len];
}

/** Which segment of an edge `s` metres along it lies on: the index of the point it starts at. */
function segmentAt(e: RoadEdge, s: number): number {
  const { cum } = e;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * How far a corner's legs reach either side of a bend of `turn` radians: the kind's corner,
 * plus what the lane on the inside of the turn needs so the offset path meets the far leg
 * before looping back (the offset lines meet |lane|·tan(turn / 2) short of the bend), plus
 * room for a change of lane between the legs, so it is eased rather than stepped.
 */
export function legFor(corner: number, turn: number, la: number, lb: number): number {
  const inside = Math.max(Math.abs(la), Math.abs(lb)) * Math.tan(Math.min(turn, 2.6) / 2);
  return Math.max(corner + inside, 1.5 * Math.abs(lb - la));
}

/**
 * A point on the curve round a bend at (vx, vz) from the direction in (ax, az) to the
 * direction out (bx, bz), `r` metres either side of it, in lane space: a quadratic Bézier from
 * the lane `la` right of the way in to the lane `lb` right of the way out, its control point
 * where the two offset lines meet, so the path keeps its distance from the line through the
 * bend. Straight on (or a lane change along a straight), the control is halfway; back the way
 * it came (a hairpin), it is out past the bend, so the path loops round in front of it; and
 * where the offset lines meet behind the start or beyond the end (a tight turn to the inside
 * on short legs), the path cuts straight across rather than looping back. Written into `out`
 * as the point and the curve's own tangent at `t` (0 to 1), which is the way the vehicle is
 * drawn heading.
 */
export function cornerAt(
  vx: number,
  vz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  r: number,
  la: number,
  lb: number,
  t: number,
  out: [number, number, number, number],
): [number, number, number, number] {
  // Right of a heading in (x east, z south) is (-dz, dx).
  const [p0x, p0z] = [vx - ax * r - az * la, vz - az * r + ax * la];
  const [p2x, p2z] = [vx + bx * r - bz * lb, vz + bz * r + bx * lb];
  const cross = ax * bz - az * bx;
  const dot = ax * bx + az * bz;
  let [cx, cz] = [(p0x + p2x) / 2, (p0z + p2z) / 2];
  if (dot < -0.95) {
    const reach = r + (Math.abs(la) + Math.abs(lb)) / 2;
    [cx, cz] = [vx + ax * reach, vz + az * reach];
  } else if (Math.abs(cross) > 0.02) {
    const [dx, dz] = [p2x - p0x, p2z - p0z];
    const u = (dx * bz - dz * bx) / cross;
    const w = (ax * dz - az * dx) / cross;
    if (u > 0 && w > 0) [cx, cz] = [p0x + ax * u, p0z + az * u];
  }
  const s = 1 - t;
  out[0] = s * s * p0x + 2 * s * t * cx + t * t * p2x;
  out[1] = s * s * p0z + 2 * s * t * cz + t * t * p2z;
  let tx = 2 * s * (cx - p0x) + 2 * t * (p2x - cx);
  let tz = 2 * s * (cz - p0z) + 2 * t * (p2z - cz);
  const len = Math.hypot(tx, tz);
  if (len < 1e-6) [tx, tz] = t < 0.5 ? [ax, az] : [bx, bz];
  else [tx, tz] = [tx / len, tz / len];
  out[2] = tx;
  out[3] = tz;
  return out;
}

/**
 * Turns a drawn heading towards where the path heads, at most `rate` radians a second: what
 * makes a corner a swing rather than a snap. Returns the new heading (radians).
 */
export function turnTowards(yaw: number, goal: number, rate: number, dt: number): number {
  let d = goal - yaw;
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
  const most = rate * dt;
  return yaw + Math.max(-most, Math.min(most, d));
}
