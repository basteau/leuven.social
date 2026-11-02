import type { City, Way, WayKind } from '../data/city.ts';
import { alongEdge, roadGraph, turnBetween } from '../data/traffic.ts';
import type { RoadEdge, RoadGraph } from '../data/traffic.ts';
import type {
  BackSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshToonMaterial,
  Texture,
} from 'three';

import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { BUS, CARS, GUESTS, PROPS, WINDOW } from './palette.ts';

/**
 * Traffic: cars, buses and bikes driving the streets (src/data/traffic.ts builds the graph). A
 * chunk of its own, loaded once the first frame is drawn, that takes what it shares with the
 * engine as a `kit` (three's classes, `MeshBuilder`) like the furniture. Each vehicle follows
 * the edge it is on at a cruise it can hold, keeps its distance from the one ahead (a trimmed
 * intelligent-driver model), slows for the corner it has chosen next and picks the next edge
 * at random, straight on three times as often as a turn. Nothing is routed, nothing is simulated
 * off the graph, and a vehicle that runs off the map's edge comes back somewhere else.
 */

export type VehicleKind = 'car' | 'bus' | 'bike';
export const VEHICLE_KINDS = ['car', 'bus', 'bike'] as const;

export interface Vehicle {
  kind: VehicleKind;
  /** The edge it is on and how far along it (m), its speed (m/s) and the cruise it aims for. */
  edge: number;
  s: number;
  speed: number;
  cruise: number;
  /** The edge it will take next, or -1 at a dead end, and the turn into it (radians). */
  next: number;
  turn: number;
  /** Its lane: how far right of the edge's line it drives (m). */
  lane: number;
  /** Its paint (a shirt, on a bike), as linear RGB for the shader. */
  paint: [number, number, number];
  /** On the streets, or parked out of sight until the view has room for it. */
  active: boolean;
}

/**
 * The fleet: the most of each kind there ever are. They keep to the streets round the view
 * (`focus`): as many as its area deserves at the density below, no fewer than the floor, and
 * one that drives off beyond it comes back on a street inside it, out of sight.
 */
export const COUNTS: Record<VehicleKind, number> = { car: 220, bus: 14, bike: 300 };
/** Vehicles per km² of the focus's circle, and the fewest of each kind, however small it is. */
export const DENSITY: Record<VehicleKind, number> = { car: 150, bus: 10, bike: 220 };
export const FLOOR: Record<VehicleKind, number> = { car: 30, bus: 3, bike: 50 };
/**
 * Spawning keeps this share of the radius away from the focus (out of the view), and a vehicle
 * beyond this many radii is recycled. The focus is refitted once it moves this far.
 */
const SPAWN_FROM = 0.5;
const RECYCLE_AT = 1.3;
const REFOCUS_AT = 40;
/** Respawns a step, so nothing stalls a frame: the fleet fills in over a second or so. */
const RESPAWN_BUDGET = 12;
/** Length (m), from bumper to bumper, that the gap to the one ahead is measured from. */
export const LENGTH: Record<VehicleKind, number> = { car: 4.2, bus: 12, bike: 1.8 };
/** Cruising speed (m/s) by kind of way; 0 where it may not drive. */
const CRUISE: Record<VehicleKind, Record<WayKind, number>> = {
  car: { main: 12, street: 8, cycle: 0 },
  bus: { main: 10, street: 7, cycle: 0 },
  bike: { main: 5, street: 4.5, cycle: 4.5 },
};
/** Standing gap (m), time headway (s), acceleration and comfortable braking (m/s²). */
const GAP: Record<VehicleKind, number> = { car: 2.5, bus: 4, bike: 1 };
const HEADWAY = 1.2;
const ACCEL: Record<VehicleKind, number> = { car: 2, bus: 1.2, bike: 1.2 };
const BRAKE = 3;
/** The speed (m/s) a sharp corner is taken at, and what counts as one (radians). */
const TURN_SPEED = 3.5;
const SHARP = 0.35;
/** Straight on is this many times as likely as a turn. */
const STRAIGHT_WEIGHT = 3;
/** The lane each kind keeps, right of the line, on a two-way street and on a one-way one (m). */
const LANES: Record<VehicleKind, [twoWay: number, oneWay: number]> = {
  car: [1.6, 0.2],
  bus: [1.7, 0.2],
  bike: [2.6, 1.4],
};
/** Spawning keeps this clear (m) of anyone else on the edge. */
const SPAWN_GAP = 12;

const motor = (kind: VehicleKind) => kind !== 'bike';

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

/** One sRGB channel, 0 to 255, as linear light. */
const channel = (v: number): number => {
  const u = v / 255;
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
};
const hexToLinear = (hex: number): [number, number, number] => [
  channel((hex >> 16) & 255),
  channel((hex >> 8) & 255),
  channel(hex & 255),
];

export class Traffic {
  readonly graph: RoadGraph;
  readonly vehicles: Vehicle[] = [];
  /** Edges a motor vehicle may take, and a bike, each with its cumulative length for spawning. */
  readonly #lanes: Record<'motor' | 'bike', { edges: number[]; cum: number[] }>;
  /** Whether each edge has a twin running the other way: where the lane is kept right. */
  readonly #twoWay: Uint8Array;
  readonly #random: () => number;
  /** Vehicles sorted by edge, class and distance along, rebuilt each step for the leader search. */
  readonly #order: number[] = [];
  /** The first vehicle of each class on each edge, after a sort (-1: none). */
  readonly #first: Int32Array;
  /** Where the view looks and how far round it the traffic keeps; the edges within. */
  readonly #focus = { x: Number.NaN, z: Number.NaN, radius: 0 };
  #near: Record<'motor' | 'bike', { edges: number[]; cum: number[] }> | null = null;
  readonly #mid: Float32Array;
  #want: Record<VehicleKind, number> = { ...COUNTS };
  /** Where the round-robin scan for vehicles to recycle got to. */
  #scan = 0;
  /** Filling the circle after a jump (or at the start): spawns land anywhere in it, in view too. */
  #filling = true;

  constructor(ways: readonly Way[], seed = 1, counts: Record<VehicleKind, number> = COUNTS) {
    this.graph = roadGraph(ways);
    const { edges, nodes } = this.graph;
    this.#random = mulberry32(seed);
    this.#twoWay = new Uint8Array(edges.length);
    const twin = new Set(edges.map((e) => `${e.from}>${e.to}`));
    for (const [i, e] of edges.entries()) this.#twoWay[i] = twin.has(`${e.to}>${e.from}`) ? 1 : 0;
    const lanes = (allowed: (e: RoadEdge) => boolean) => {
      const list: number[] = [];
      const cum: number[] = [];
      let total = 0;
      for (const [i, e] of edges.entries()) {
        // A dead end spawns nobody: they would drive off at once.
        if (!allowed(e) || nodes[e.to]!.out.length === 0) continue;
        list.push(i);
        cum.push((total += e.length));
      }
      return { edges: list, cum };
    };
    this.#lanes = { motor: lanes((e) => e.cars), bike: lanes((e) => e.bikes) };
    this.#first = new Int32Array(edges.length * 2);
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
          edge: 0,
          s: 0,
          speed: 0,
          cruise: 1,
          next: -1,
          turn: 0,
          lane: 0,
          paint: this.#paint(kind),
          active: false,
        });
      }
    }
    for (let i = 0; i < this.vehicles.length; i++) this.#order.push(i);
  }

  /**
   * Keeps the traffic round a spot: the edges within `radius` of it are where vehicles spawn,
   * and how many are out is what that circle's area deserves. Called with the view's target
   * every frame; it does the work only once the spot has moved a few dozen metres or the
   * radius has changed. A jump (a reset, a flight) re-places the whole fleet at once.
   */
  focus(x: number, z: number, radius: number): void {
    const f = this.#focus;
    const moved = Math.hypot(x - f.x, z - f.z);
    if (moved < REFOCUS_AT && Math.abs(radius - f.radius) < 0.15 * f.radius) return;
    const jump = !(moved < 2 * f.radius);
    [f.x, f.z, f.radius] = [x, z, radius];
    const within = (i: number) =>
      Math.hypot(this.#mid[i * 2]! - x, this.#mid[i * 2 + 1]! - z) <= radius;
    const near = (pool: { edges: number[]; cum: number[] }) => {
      const edges: number[] = [];
      const cum: number[] = [];
      let total = 0;
      for (const [k, i] of pool.edges.entries()) {
        if (!within(i)) continue;
        edges.push(i);
        cum.push((total += pool.cum[k]! - (pool.cum[k - 1] ?? 0)));
      }
      return { edges, cum };
    };
    this.#near = { motor: near(this.#lanes.motor), bike: near(this.#lanes.bike) };
    const area = (Math.PI * radius * radius) / 1e6;
    for (const kind of VEHICLE_KINDS) {
      this.#want[kind] = Math.min(
        COUNTS[kind],
        Math.max(FLOOR[kind], Math.round(DENSITY[kind] * area)),
      );
    }
    if (jump) {
      // Everyone parks and comes out again over the next second, all over the circle, the view
      // included: nothing would reach it for minutes otherwise.
      for (const v of this.vehicles) v.active = false;
      this.#filling = true;
    }
  }

  /** How far a spot is from the focus, or nothing without one. */
  #fromFocus(x: number, z: number): number {
    return Number.isNaN(this.#focus.x) ? 0 : Math.hypot(x - this.#focus.x, z - this.#focus.z);
  }

  /**
   * A random edge of the class, by length, near the focus (where there is one) and out of its
   * view (unless `anywhere`), and a spot on it clear of the others.
   */
  #spawn(kind: VehicleKind, anywhere = false): Vehicle | null {
    const cls = motor(kind) ? 'motor' : 'bike';
    const { edges: pool, cum } = this.#near?.[cls].edges.length
      ? this.#near[cls]
      : this.#lanes[cls];
    const total = cum.at(-1) ?? 0;
    if (!total) return null;
    const spot: [number, number, number, number] = [0, 0, 0, 0];
    for (let tries = 0; tries < 12; tries++) {
      const pick = this.#random() * total;
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid]! < pick) lo = mid + 1;
        else hi = mid;
      }
      const edge = pool[lo]!;
      const e = this.graph.edges[edge]!;
      const s = e.length * (0.1 + 0.8 * this.#random());
      // Out of the view, unless no try finds a spot there.
      alongEdge(e, s, spot);
      const { radius } = this.#focus;
      const away = this.#fromFocus(spot[0], spot[1]);
      const hidden = anywhere ? away <= radius : away >= SPAWN_FROM * radius && away <= radius;
      if (radius > 0 && tries < 9 && !hidden) continue;
      const clear = this.vehicles.every(
        (o) =>
          !o.active ||
          o.edge !== edge ||
          motor(o.kind) !== motor(kind) ||
          Math.abs(o.s - s) > SPAWN_GAP,
      );
      if (!clear) continue;
      const cruise = this.#cruise(kind, e);
      const v: Vehicle = {
        kind,
        edge,
        s,
        speed: cruise * (0.5 + 0.5 * this.#random()),
        cruise,
        next: -1,
        turn: 0,
        lane: this.#lane(kind, edge),
        paint: this.#paint(kind),
        active: true,
      };
      this.#choose(v);
      return v;
    }
    return null;
  }

  #paint(kind: VehicleKind): [number, number, number] {
    const list = kind === 'car' ? CARS : kind === 'bus' ? [BUS.body] : GUESTS.shirts;
    return hexToLinear(list[Math.floor(this.#random() * list.length)]!);
  }

  /** The cruise on an edge: slower on a bend-ridden short edge too, so corners aren't cut. */
  #cruise(kind: VehicleKind, e: RoadEdge): number {
    return CRUISE[kind][e.kind] * (0.9 + 0.2 * this.#random());
  }

  #lane(kind: VehicleKind, edge: number): number {
    return LANES[kind][this.#twoWay[edge] ? 0 : 1];
  }

  /** Picks where a vehicle goes after its edge: straight on, mostly; never back unless it must. */
  #choose(v: Vehicle): void {
    const { edges, nodes } = this.graph;
    const e = edges[v.edge]!;
    const allowed = nodes[e.to]!.out.filter((i) =>
      motor(v.kind) ? edges[i]!.cars : edges[i]!.bikes,
    );
    const onward = allowed.filter((i) => edges[i]!.to !== e.from);
    const options = onward.length ? onward : allowed;
    if (!options.length) {
      v.next = -1;
      v.turn = 0;
      return;
    }
    const turns = options.map((i) => turnBetween(e, edges[i]!));
    const weights = turns.map((t) => (t < SHARP ? STRAIGHT_WEIGHT : 1));
    let pick = this.#random() * weights.reduce((a, b) => a + b, 0);
    let chosen = options.length - 1;
    for (const [i, w] of weights.entries()) {
      if ((pick -= w) <= 0) {
        chosen = i;
        break;
      }
    }
    v.next = options[chosen]!;
    v.turn = turns[chosen]!;
  }

  /** Sorts the vehicles so each one's leader is the next in its edge and class. */
  #sort(): void {
    const { vehicles } = this;
    // Parked vehicles sort last, past every edge, and claim no place on one.
    const key = (i: number) => {
      const v = vehicles[i]!;
      return v.active ? v.edge * 2 + (motor(v.kind) ? 0 : 1) : this.#first.length;
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
    const out: Record<VehicleKind, number> = { car: 0, bus: 0, bike: 0 };
    for (const v of vehicles) if (v.active) out[v.kind]++;
    if (VEHICLE_KINDS.every((k) => out[k] >= this.#want[k])) this.#filling = false;
    const spot: [number, number, number, number] = [0, 0, 0, 0];
    for (let n = 0, done = 0; n < vehicles.length && done < RESPAWN_BUDGET; n++) {
      const v = vehicles[(this.#scan = (this.#scan + 1) % vehicles.length)]!;
      const want = this.#want[v.kind];
      if (v.active) {
        this.place(v, spot);
        if (this.#fromFocus(spot[0], spot[1]) <= RECYCLE_AT * radius) continue;
        if (out[v.kind] > want) {
          v.active = false;
          out[v.kind]--;
        } else {
          const fresh = this.#spawn(v.kind);
          if (fresh) Object.assign(v, fresh);
        }
        done++;
      } else if (out[v.kind] < want) {
        const fresh = this.#spawn(v.kind, this.#filling);
        if (!fresh) continue;
        Object.assign(v, fresh);
        out[v.kind]++;
        done++;
      }
    }
  }

  /** Advances every vehicle by `dt` seconds (clamped by the caller to a few hundredths). */
  step(dt: number): void {
    const { vehicles } = this;
    const { edges } = this.graph;
    this.#recycle();
    this.#sort();
    const order = this.#order;
    for (let k = 0; k < order.length; k++) {
      const i = order[k]!;
      const v = vehicles[i]!;
      if (!v.active) break; // the parked ones sort last
      const e = edges[v.edge]!;
      // The one ahead: next in the order on the same edge and class, else first on the next edge.
      let gap = Infinity;
      let ahead = 0;
      const after = order[k + 1];
      const peer = after === undefined ? undefined : vehicles[after];
      if (peer && peer.edge === v.edge && motor(peer.kind) === motor(v.kind)) {
        gap = peer.s - LENGTH[peer.kind] / 2 - (v.s + LENGTH[v.kind] / 2);
        ahead = peer.speed;
      } else if (v.next >= 0) {
        const first = this.#first[v.next * 2 + (motor(v.kind) ? 0 : 1)]!;
        if (first >= 0) {
          const o = vehicles[first]!;
          gap = e.length - v.s + o.s - LENGTH[o.kind] / 2 - LENGTH[v.kind] / 2;
          ahead = o.speed;
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
      const end = v.next < 0 ? 0 : v.turn > SHARP ? TURN_SPEED : v.cruise;
      const room = Math.max(0, e.length - v.s);
      const cap = Math.sqrt(end * end + 2 * BRAKE * room);
      v.speed = Math.max(0, Math.min(v.speed + acc * dt, cap));
      v.s += v.speed * dt;
      if (v.s >= e.length) {
        if (v.next < 0) {
          // Off the map's edge or into a cul-de-sac: back in somewhere else.
          const fresh = this.#spawn(v.kind);
          if (fresh) Object.assign(v, fresh);
          else v.s = e.length;
          continue;
        }
        v.s -= e.length;
        v.edge = v.next;
        const onto = edges[v.edge]!;
        v.cruise = this.#cruise(v.kind, onto);
        v.speed = Math.min(v.speed, v.cruise);
        v.lane = this.#lane(v.kind, v.edge);
        this.#choose(v);
      }
    }
  }

  /** Where a vehicle is: its spot, in its lane, and the way it heads (unit). */
  place(
    v: Vehicle,
    out: [number, number, number, number] = [0, 0, 0, 0],
  ): [number, number, number, number] {
    alongEdge(this.graph.edges[v.edge]!, v.s, out);
    const [dx, dz] = [out[2], out[3]];
    // Right-hand traffic: right of the heading in (x east, z south) is (-dz, dx).
    out[0] += -dz * v.lane;
    out[1] += dx * v.lane;
    return out;
  }
}

/**
 * The vehicles' shapes, in their own frame: x ahead, y up, z to the right, drawn once each and
 * instanced. Vertex colours carry what doesn't change; the `facade` attribute says what does:
 * PAINT takes the instance's colour, HEAD and TAIL glow at night.
 */
export const PART = { plain: 0, head: 1, tail: 2, paint: 3 } as const;

type Builder = Pick<MeshBuilder, 'quad' | 'triangle'>;

const corner = (x: number, y: number, z: number): V3 => [x, y, z];

/** An axis-aligned box: five or six faces, in one colour, with one `facade` part code. */
function boxOf(
  mesh: Builder,
  [x0, x1]: readonly [number, number],
  [y0, y1]: readonly [number, number],
  [z0, z1]: readonly [number, number],
  color: number,
  part: number = PART.plain,
  bottom = false,
): void {
  mesh.quad(
    corner(x0, y1, z0),
    corner(x1, y1, z0),
    corner(x1, y1, z1),
    corner(x0, y1, z1),
    color,
    [0, 1, 0],
    part,
  );
  mesh.quad(
    corner(x1, y0, z0),
    corner(x1, y0, z1),
    corner(x1, y1, z1),
    corner(x1, y1, z0),
    color,
    [1, 0, 0],
    part,
  );
  mesh.quad(
    corner(x0, y0, z1),
    corner(x0, y0, z0),
    corner(x0, y1, z0),
    corner(x0, y1, z1),
    color,
    [-1, 0, 0],
    part,
  );
  mesh.quad(
    corner(x0, y0, z1),
    corner(x1, y0, z1),
    corner(x1, y1, z1),
    corner(x0, y1, z1),
    color,
    [0, 0, 1],
    part,
  );
  mesh.quad(
    corner(x1, y0, z0),
    corner(x0, y0, z0),
    corner(x0, y1, z0),
    corner(x1, y1, z0),
    color,
    [0, 0, -1],
    part,
  );
  if (bottom)
    mesh.quad(
      corner(x0, y0, z1),
      corner(x0, y0, z0),
      corner(x1, y0, z0),
      corner(x1, y0, z1),
      color,
      [0, -1, 0],
      part,
    );
}

/** A lamp: a small quad on the front (ahead) or back face, glowing at night. */
function lamp(mesh: Builder, x: number, y: number, z: number, head: boolean): void {
  const dir = head ? 1 : -1;
  const [c, part] = head ? [BUS.headlamp, PART.head] : [BUS.taillamp, PART.tail];
  const p = (dy: number, dz: number): V3 => [x + dir * 0.01, y + dy, z + dz];
  if (head)
    mesh.quad(p(-0.1, -0.16), p(-0.1, 0.16), p(0.1, 0.16), p(0.1, -0.16), c, [dir, 0, 0], part);
  else mesh.quad(p(-0.1, 0.16), p(-0.1, -0.16), p(0.1, -0.16), p(0.1, 0.16), c, [dir, 0, 0], part);
}

/** A hatchback: a painted body and cabin, glass round the cabin, four wheels, lamps. */
export function addCar(mesh: Builder, grow = 1): void {
  const g = grow;
  boxOf(mesh, [-2.1 * g, 2.1 * g], [0.35, 0.95 * g], [-0.88 * g, 0.88 * g], 0xffffff, PART.paint);
  boxOf(mesh, [-1.1 * g, 0.8 * g], [0.95 * g, 1.5 * g], [-0.78 * g, 0.78 * g], WINDOW.glass);
  boxOf(
    mesh,
    [-1.05 * g, 0.75 * g],
    [1.5 * g, 1.56 * g],
    [-0.74 * g, 0.74 * g],
    0xffffff,
    PART.paint,
  );
  for (const x of [-1.35, 1.35]) {
    for (const z of [-0.8, 0.8]) {
      boxOf(
        mesh,
        [x - 0.33 * g, x + 0.33 * g],
        [0, 0.66 * g],
        [z - 0.12 * g, z + 0.12 * g],
        PROPS.wheel,
        PART.plain,
        true,
      );
    }
  }
  if (g === 1) {
    for (const z of [-0.58, 0.58]) {
      lamp(mesh, 2.1, 0.72, z, true);
      lamp(mesh, -2.1, 0.72, z, false);
    }
  }
}

/** A city bus: a long cream body with a band of windows, a coloured stripe, wheels and lamps. */
export function addBus(mesh: Builder, grow = 1): void {
  const g = grow;
  boxOf(mesh, [-6 * g, 6 * g], [0.5, 3.2 * g], [-1.25 * g, 1.25 * g], 0xffffff, PART.paint);
  if (g === 1) {
    for (const side of [-1, 1]) {
      const z: [number, number] = side < 0 ? [-1.27, -1.25] : [1.25, 1.27];
      boxOf(mesh, [-5.6, 5.6], [1.7, 2.7], z, WINDOW.glass);
      boxOf(mesh, [-6.01, 6.01], [1.2, 1.5], z, BUS.band);
    }
    boxOf(mesh, [5.99, 6.02], [1.5, 2.9], [-1.1, 1.1], WINDOW.glass);
    for (const z of [-0.85, 0.85]) {
      lamp(mesh, 6, 0.9, z, true);
      lamp(mesh, -6, 0.9, z, false);
    }
  }
  for (const x of [-4, 4]) {
    for (const z of [-1.1, 1.1]) {
      boxOf(
        mesh,
        [x - 0.5 * g, x + 0.5 * g],
        [0, 1 * g],
        [z - 0.15 * g, z + 0.15 * g],
        PROPS.wheel,
        PART.plain,
        true,
      );
    }
  }
}

/** A cyclist: two wheels, a frame, legs, a shirt in the instance's colour, a head and hair. */
export function addBike(mesh: Builder, grow = 1): void {
  const g = grow;
  for (const x of [-0.55, 0.55]) {
    boxOf(
      mesh,
      [x - 0.34 * g, x + 0.34 * g],
      [0, 0.68 * g],
      [-0.04 * g, 0.04 * g],
      PROPS.wheel,
      PART.plain,
      true,
    );
  }
  boxOf(mesh, [-0.5 * g, 0.55 * g], [0.55, 0.64 * g], [-0.04 * g, 0.04 * g], PROPS.iron);
  boxOf(mesh, [0.45 * g, 0.55 * g], [0.64, 1.05 * g], [-0.3 * g, 0.3 * g], PROPS.iron);
  boxOf(mesh, [-0.12 * g, 0.2 * g], [0.45, 0.95 * g], [-0.16 * g, 0.16 * g], GUESTS.legs[0]!);
  boxOf(mesh, [-0.14 * g, 0.26 * g], [0.95, 1.52 * g], [-0.22 * g, 0.22 * g], 0xffffff, PART.paint);
  boxOf(mesh, [0.05 * g, 0.33 * g], [1.52, 1.8 * g], [-0.13 * g, 0.13 * g], GUESTS.skin[1]!);
  boxOf(mesh, [0.03 * g, 0.35 * g], [1.74, 1.86 * g], [-0.15 * g, 0.15 * g], GUESTS.hair[1]!);
}

export const SHAPES: Record<VehicleKind, (mesh: Builder, grow?: number) => void> = {
  car: addCar,
  bus: addBus,
  bike: addBike,
};

/** Each shape's ink hull: the same boxes grown a little, drawn inside out behind it. */
export const HULL_GROW = 1.06;

/** How far over the carriageway's surface the wheels ride, so they never sink in it (m). */
export const RIDE_HEIGHT = 0.03;

/** The three.js classes the layer takes from the engine, so this chunk imports none itself. */
export interface TrafficThree {
  InstancedMesh: typeof InstancedMesh;
  InstancedBufferAttribute: typeof InstancedBufferAttribute;
  Matrix4: typeof Matrix4;
  MeshToonMaterial: typeof MeshToonMaterial;
  MeshBasicMaterial: typeof MeshBasicMaterial;
  BackSide: typeof BackSide;
}

/** What the chunk takes from the engine rather than importing it, as the furniture does. */
export interface TrafficKit {
  three: TrafficThree;
  MeshBuilder: typeof MeshBuilder;
  linearVertexColors: (vertexShader: string) => string;
  city: Pick<City, 'ways'>;
  /** The ground a vehicle rides on at a spot: the carriageway as drawn (m). */
  ground: (x: number, z: number) => number;
  gradientMap: Texture;
  /** How far into the night it is, for the lamps (the facade material's uniform). */
  night: { value: number };
  ink: number;
}

export interface TrafficLayer {
  /** The meshes to add to the scene: a body and an ink hull per kind. */
  meshes: InstancedMesh[];
  traffic: Traffic;
  /**
   * Keeps the fleet round a spot (the view's target) within `radius`, steps the traffic and
   * moves every instance; returns how many vehicles are on the streets.
   */
  update(dt: number, x: number, z: number, radius: number): number;
  dispose(): void;
}

/**
 * The traffic on the streets, drawn: one instanced mesh per kind, with an inverted hull in ink
 * behind it sharing its matrices, two draw calls a kind. Bodies take the city's toon shading
 * and its shadows; the `paint` attribute colours the painted parts, and the lamps glow at night.
 */
export function createTrafficLayer(kit: TrafficKit, seed = 1): TrafficLayer {
  const { three, MeshBuilder, linearVertexColors, gradientMap, night } = kit;
  const traffic = new Traffic(kit.city.ways, seed);
  const byKind = Object.fromEntries(
    VEHICLE_KINDS.map((k) => [k, traffic.vehicles.filter((v) => v.kind === k)]),
  ) as Record<VehicleKind, Vehicle[]>;
  const material = new three.MeshToonMaterial({ vertexColors: true, gradientMap });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = night;
    shader.vertexShader = linearVertexColors(shader.vertexShader)
      .replace(
        '#include <common>',
        '#include <common>\nattribute float facade;\nattribute vec3 paint;\nvarying float vPart;',
      )
      .replace(
        '#include <color_vertex>',
        '#include <color_vertex>\nvPart = facade;\nif (facade > 2.5) vColor.rgb = paint;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uNight;\nvarying float vPart;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (vPart > 0.5 && vPart < 2.5) {
          totalEmissiveRadiance += (vPart < 1.5 ? vec3(1.0, 0.92, 0.7) : vec3(0.9, 0.08, 0.04)) * uNight;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'vehicle-v1';
  const inkMaterial = new three.MeshBasicMaterial({ color: kit.ink, side: three.BackSide });
  const meshes: InstancedMesh[] = [];
  const matrix = new three.Matrix4();
  const groups: { mesh: InstancedMesh; vehicles: Vehicle[] }[] = [];
  for (const kind of VEHICLE_KINDS) {
    const vehicles = byKind[kind];
    const body = new MeshBuilder();
    SHAPES[kind](body);
    const hull = new MeshBuilder();
    SHAPES[kind](hull, HULL_GROW);
    const geometry = body.build({ facade: true, keep: true });
    const paint = new Float32Array(vehicles.length * 3);
    for (const [i, v] of vehicles.entries()) paint.set(v.paint, i * 3);
    geometry.setAttribute('paint', new three.InstancedBufferAttribute(paint, 3));
    const mesh = new three.InstancedMesh(geometry, material, vehicles.length);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const ink = new three.InstancedMesh(hull.build({ keep: true }), inkMaterial, vehicles.length);
    ink.instanceMatrix = mesh.instanceMatrix;
    ink.frustumCulled = false;
    meshes.push(mesh, ink);
    groups.push({ mesh, vehicles });
  }
  const spot: [number, number, number, number] = [0, 0, 0, 0];
  return {
    meshes,
    traffic,
    update(dt, fx, fz, radius) {
      traffic.focus(fx, fz, radius);
      traffic.step(dt);
      let drawn = 0;
      for (const { mesh, vehicles } of groups) {
        for (const [i, v] of vehicles.entries()) {
          if (!v.active) {
            // Parked out of sight: nothing of it, until it is let out again.
            mesh.setMatrixAt(i, matrix.makeScale(0, 0, 0));
            continue;
          }
          drawn++;
          traffic.place(v, spot);
          const [x, z, dx, dz] = spot;
          // Local x ahead: a turn about y by atan2(-dz, dx) takes it to (dx, dz).
          matrix.makeRotationY(Math.atan2(-dz, dx));
          matrix.setPosition(x, kit.ground(x, z) + RIDE_HEIGHT, z);
          mesh.setMatrixAt(i, matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
      return drawn;
    },
    dispose() {
      for (const m of meshes) m.geometry.dispose();
      material.dispose();
      inkMaterial.dispose();
    },
  };
}
