import { PAVED } from '../data/city.ts';
import type { Surface, Way, WayKind } from '../data/city.ts';
import type { GraphRouter } from '../data/graph-route.ts';
import {
  PAVEMENT,
  alongEdge,
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
  /** Its lane: how far right of the edge's line it keeps (m), here and on the next edge. */
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
}

/**
 * The fleet: the most of each kind there ever are. They keep to the streets round the view
 * (`focus`): as many as its area deserves at the density below, no fewer than the floor, and
 * one that drives off beyond it comes back on a street inside it, out of sight.
 */
export const COUNTS: Record<VehicleKind, number> = { car: 220, bus: 14, bike: 300, person: 300 };
/** Vehicles per km² of the focus's circle, and the fewest of each kind, however small it is. */
export const DENSITY: Record<VehicleKind, number> = { car: 150, bus: 10, bike: 220, person: 260 };
export const FLOOR: Record<VehicleKind, number> = { car: 30, bus: 3, bike: 50, person: 60 };
/**
 * Spawning keeps this share of the radius away from the focus (out of the view), and a vehicle
 * beyond this many radii is recycled. The focus is refitted once it moves this far.
 */
const SPAWN_FROM = 0.5;
const RECYCLE_AT = 1.3;
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
/** How fast the drawn heading may turn (rad/s): a bus swings round slower than a cyclist. */
export const TURN_RATE: Record<VehicleKind, number> = { car: 2.2, bus: 1.4, bike: 3.5, person: 6 };
/**
 * Metres per stride (on foot) or pedal turn (on a bike): what one cycle of the legs covers. A
 * person's is a stroll's two steps at the figure's size (a third over life), a bike's a city
 * bike's gearing.
 */
export const STRIDE: Record<VehicleKind, number> = { car: 1, bus: 1, bike: 5, person: 2 };
/** Where the indicators come on before a turn (m), and how far into the junction one may hold. */
const SIGNAL_AT = 30;
const CLAIM_AHEAD = 2;
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
export function laneFor(kind: VehicleKind, e: RoadEdge, twoWay: boolean, jitter: number): number {
  const { right, left } = e;
  const w = right.edge;
  const kerb = right.kerb;
  switch (kind) {
    case 'car':
    case 'bus':
      if (kerb > 0)
        return twoWay ? Math.min(1.8, Math.max(0.3, kerb * 0.5)) : Math.min(0.4, kerb * 0.12);
      return twoWay ? Math.min(1.7, Math.max(0.3, w * 0.45)) : Math.min(0.3, w * 0.1);
    case 'bike':
      if (e.kind === 'cycle') {
        return (twoWay ? Math.min(0.8, (kerb || w) * 0.3) : 0) + 0.2 * jitter;
      }
      if (e.kind === 'pedestrian') return Math.min(1.5, w * 0.3) + 0.3 * jitter;
      if (kerb > 0) return Math.max(0.3, kerb - 0.7) + 0.2 * jitter;
      return (twoWay ? Math.min(2.8, w * 0.7) : Math.min(1.5, w * 0.5)) + 0.25 * jitter;
    default: {
      if (e.kind === 'path') return 0.4 * jitter;
      if (e.kind === 'pedestrian') return Math.min(6, w) * 0.5 * jitter;
      const across = (side: typeof right, pavement: number) =>
        side.kerb + PAVEMENT_MARGIN + (pavement - 2 * PAVEMENT_MARGIN) * (0.5 + 0.5 * jitter);
      const onRight = pavementOf(right);
      if (onRight >= PAVEMENT) return across(right, onRight);
      const onLeft = pavementOf(left);
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
  /** The edges each class may use anywhere, and those near the focus. */
  readonly #pools: Pool[];
  #near: Pool[] | null = null;
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
      roadRouter(this.graph, (i) => ROUTE_COST[cls as 0 | 1 | 2][edges[i]!.kind]),
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
    this.#pools = this.#allowed.map((allowed) => {
      const list: number[] = [];
      const cum: number[] = [];
      let total = 0;
      for (const [i, e] of edges.entries()) {
        // Nobody spawns on, or heads for, an edge that leads nowhere but back the way it came
        // (a cul-de-sac, the map's edge): they would turn round or drive off at once.
        const onward = nodes[e.to]!.out.some((j) => j !== this.#twin[i] && allowed(j));
        if (!allowed(i) || !onward) continue;
        list.push(i);
        cum.push((total += e.length));
      }
      return { edges: list, cum };
    });
    this.#first = new Int32Array(edges.length * CLASSES);
    this.#claim = new Int32Array(nodes.length * CLASSES).fill(-1);
    this.#claimFrom = new Int32Array(nodes.length * CLASSES).fill(-1);
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
          lane: 0,
          laneNext: 0,
          jitter: this.#random() * 2 - 1,
          paint: this.#paint(kind),
          yaw: 0,
          brake: 0,
          phase: this.#random() * Math.PI * 2,
          blink: this.#random(),
          hold: -1,
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
    const within = (i: number) =>
      Math.hypot(this.#mid[i * 2]! - x, this.#mid[i * 2 + 1]! - z) <= radius;
    this.#near = this.#pools.map((pool) => {
      const edges: number[] = [];
      const cum: number[] = [];
      let total = 0;
      for (const [k, i] of pool.edges.entries()) {
        if (!within(i)) continue;
        edges.push(i);
        cum.push((total += pool.cum[k]! - (pool.cum[k - 1] ?? 0)));
      }
      return { edges, cum };
    });
    const area = (Math.PI * radius * radius) / 1e6;
    for (const kind of VEHICLE_KINDS) {
      this.#want[kind] = Math.min(
        COUNTS[kind],
        Math.max(FLOOR[kind], Math.round(DENSITY[kind] * area)),
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
    const pool = this.#near?.[cls]!.edges.length ? this.#near[cls]! : this.#pools[cls]!;
    if (!pool.edges.length) return false;
    const spot: [number, number, number, number] = [0, 0, 0, 0];
    for (let tries = 0; tries < 12; tries++) {
      const edge = this.#pick(pool);
      const e = this.graph.edges[edge]!;
      const s = e.length * (0.1 + 0.8 * this.#random());
      // Out of the view, unless no try finds a spot there.
      alongEdge(e, s, spot);
      const { radius } = this.#focus;
      const away = this.#fromFocus(spot[0], spot[1]);
      const hidden = anywhere ? away <= radius : away >= SPAWN_FROM * radius && away <= radius;
      if (radius > 0 && tries < 9 && !hidden) continue;
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
      v.rIn = 0;
      v.route.length = 0;
      v.goal = -1;
      v.brake = 0;
      v.signal = 0;
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
    return CRUISE[kind][e.kind] * pace * (0.9 + 0.2 * this.#random());
  }

  #lane(v: Vehicle, edge: number): number {
    const e = this.graph.edges[edge]!;
    const twoWay = (this.#twoWay[edge]! & (1 << CLASS[v.kind])) !== 0;
    return laneFor(v.kind, e, twoWay, v.jitter);
  }

  /** How far before a node the curve between two edges starts: short edges get short curves. */
  #corner(v: Vehicle, a: RoadEdge, b: RoadEdge): number {
    return Math.min(CORNER[v.kind], 0.45 * a.length, 0.45 * b.length);
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
    const from = edges[v.edge]!.to;
    const goal = edges[this.#pick(pool)]!.to;
    if (goal === from) return;
    const most = this.#focus.radius > 0 ? 2 * this.#focus.radius + ROUTE_REACH : Infinity;
    // Never back the way it came: a goal behind it is reached round the block, or not at all.
    const back = this.#twin[v.edge]!;
    const allowed = this.#allowed[cls]!;
    const route = this.#routers[cls]!.route(from, goal, (i) => i !== back && allowed(i), most);
    if (!route) return;
    v.goal = goal;
    v.route = route.toReversed();
    // Whatever it had chosen for the node ahead, the route decides now.
    this.#choose(v);
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
      const allowed = nodes[e.to]!.out.filter(this.#allowed[CLASS[v.kind]]!);
      const onward = allowed.filter((i) => edges[i]!.to !== e.from);
      const options = onward.length ? onward : allowed;
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
    v.rOut = this.#corner(v, e, onto);
    v.laneNext = this.#lane(v, next);
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
        if (out[v.kind] > want) {
          this.#park(v);
          out[v.kind]--;
        } else this.#spawn(v);
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
   * Whether a vehicle about to cross the junction ahead may: it holds it already, nobody of
   * its class does, the holder came the same way (a queue crossing together), or the holder has
   * gone (parked, or driven on without letting go). Takes the junction when it may, if there is
   * room beyond it; people on foot cross freely.
   */
  #mayCross(i: number, v: Vehicle, e: RoadEdge, roomBeyond: boolean): boolean {
    const cls = CLASS[v.kind];
    if (cls === 2) return true;
    const node = e.to;
    const slot = this.#slot(node, cls);
    const holder = this.#claim[slot]!;
    if (holder === i) return true;
    if (holder >= 0) {
      const h = this.vehicles[holder]!;
      const stale = !h.active || h.hold !== node;
      if (!stale && this.#claimFrom[slot] === v.edge) return true;
      if (!stale) return false;
    }
    if (!roomBeyond) return false;
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
        }
      }
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
          // Off the map's edge or into a cul-de-sac: back in somewhere else.
          if (!this.#spawn(v)) v.s = e.length;
          continue;
        }
        v.s -= e.length;
        v.prev = v.edge;
        v.edge = v.next;
        v.rIn = v.rOut;
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
   * Where a vehicle is: its spot, in its lane, and the way it heads (unit). Round a junction
   * it follows a curve from the corner's start on the edge behind, through the node, to the
   * corner's end on the edge ahead, the lane blending from one edge's to the other's.
   */
  place(
    v: Vehicle,
    out: [number, number, number, number] = [0, 0, 0, 0],
  ): [number, number, number, number] {
    const { edges } = this.graph;
    const e = edges[v.edge]!;
    let lane = v.lane;
    if (v.rIn > 0 && v.s < v.rIn && v.prev >= 0) {
      // The second half of the corner behind.
      const t = 0.5 + v.s / (2 * v.rIn);
      this.#curve(edges[v.prev]!, e, v.rIn, t, out);
      lane = edges[v.prev]!.length ? laneBlend(this.#lane(v, v.prev), v.lane, t) : lane;
    } else if (v.rOut > 0 && v.s > e.length - v.rOut && v.next >= 0) {
      // The first half of the corner ahead.
      const t = (v.s - (e.length - v.rOut)) / (2 * v.rOut);
      this.#curve(e, edges[v.next]!, v.rOut, t, out);
      lane = laneBlend(v.lane, v.laneNext, t);
    } else alongEdge(e, v.s, out);
    const [dx, dz] = [out[2], out[3]];
    // Right-hand traffic: right of the heading in (x east, z south) is (-dz, dx).
    out[0] += -dz * lane;
    out[1] += dx * lane;
    return out;
  }

  /**
   * A point on the curve round the node between two edges: a quadratic Bézier from `r` before
   * the node on the first to `r` after it on the second, with its tangent, at `t` (0 to 1).
   */
  #curve(
    a: RoadEdge,
    b: RoadEdge,
    r: number,
    t: number,
    out: [number, number, number, number],
  ): void {
    const p0 = alongEdge(a, a.length - r, CURVE_A);
    const p2 = alongEdge(b, r, CURVE_B);
    const [nx, nz] = [this.graph.nodes[a.to]!.x, this.graph.nodes[a.to]!.z];
    const u = 1 - t;
    out[0] = u * u * p0[0] + 2 * u * t * nx + t * t * p2[0];
    out[1] = u * u * p0[1] + 2 * u * t * nz + t * t * p2[1];
    let tx = 2 * u * (nx - p0[0]) + 2 * t * (p2[0] - nx);
    let tz = 2 * u * (nz - p0[1]) + 2 * t * (p2[1] - nz);
    const len = Math.hypot(tx, tz);
    // A hairpin's curve has no tangent at its tip: keep the heading of the edge it is on.
    if (len < 1e-6) [tx, tz] = t < 0.5 ? [p0[2], p0[3]] : [p2[2], p2[3]];
    else [tx, tz] = [tx / len, tz / len];
    out[2] = tx;
    out[3] = tz;
  }
}

const CURVE_A: [number, number, number, number] = [0, 0, 0, 0];
const CURVE_B: [number, number, number, number] = [0, 0, 0, 0];

/** The lane eased from one edge's to the next's across a corner. */
const laneBlend = (from: number, to: number, t: number) => {
  const s = t * t * (3 - 2 * t);
  return from + (to - from) * s;
};

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
