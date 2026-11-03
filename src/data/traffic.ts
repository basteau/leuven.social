import type { Side, Surface, Way, WayKind } from './city.ts';
import { pointAlong } from './geometry.ts';
import { GraphRouter } from './graph-route.ts';
import { surfaceOf } from './roads.ts';

/**
 * The streets as a road graph for the traffic (src/scene/traffic.ts): the driveable OpenStreetMap
 * ways, split where they meet, joined again at their ends into nodes with the edges out of each.
 * Pure, so the bake splits with it and the viewer joins with it, and both are tested.
 */

type Tags = Record<string, string | undefined>;

/** Ring and through roads, where buses run and cars go faster. */
const MAIN = new Set(['motorway', 'trunk', 'primary', 'secondary']);
/** The rest of what cars drive on. */
const STREET = new Set(['tertiary', 'residential', 'unclassified', 'living_street']);
/** Paths of their own, for people on foot. */
const PATH = new Set(['footway', 'path', 'steps', 'track', 'bridleway']);
const CLOSED = new Set(['no', 'private']);
/** Access values that close a road to cars as good as `no`: permits, deliveries, farm traffic. */
const CLOSED_TO_CARS = new Set(['no', 'private', 'permit', 'delivery', 'agricultural', 'forestry']);
/** The access tags a car's right to drive a road is read from, the most specific first. */
const CAR_ACCESS = ['motorcar', 'motor_vehicle', 'vehicle', 'access'] as const;
/** A pavement at least this wide (m) is one people walk along, rather than the street. */
export const PAVEMENT = 0.9;

export interface WayStyle {
  kind: WayKind;
  /** Traffic runs one way only, along the line as stored. */
  oneway: boolean;
  /** The stored line runs against OSM's: `oneway=-1`, so the bake turns the line round. */
  reverse: boolean;
  /** A one-way street bikes may ride both ways (`oneway:bicycle=no`, Leuven's cycle streets). */
  bikesBoth: boolean;
  surface: Surface;
  /**
   * Whether OSM says there is a pavement right and left of the way as stored (`sidewalk=*`,
   * `sidewalk:left|right|both`; `separate` is one mapped as a way of its own), or nothing.
   */
  sidewalks: Sidewalks;
  /** Open to through traffic: not tagged `destination`, which only those who live there drive. */
  through: boolean;
  /** A living street: walking pace, no cutting through. */
  minor: boolean;
}

/** What the most specific of a way's access tags says a car may do, or nothing. */
export function carAccess(tags: Tags): string | undefined {
  for (const key of CAR_ACCESS) if (tags[key]) return tags[key];
  return undefined;
}

export interface Sidewalks {
  right: boolean | undefined;
  left: boolean | undefined;
}

/** OSM's word for a pavement on a side: there is one, there is none, or it doesn't say. */
const sidewalkTag = (value: string | undefined): boolean | undefined =>
  value === undefined || value === '' ? undefined : value !== 'no' && value !== 'none';

/** The pavements OSM tags on a way, right and left of the way as stored (`reverse` swaps them). */
export function sidewalksOf(tags: Tags, reverse: boolean): Sidewalks {
  let [right, left]: (boolean | undefined)[] = [undefined, undefined];
  const both = tags.sidewalk;
  if (both === 'both' || both === 'separate') [right, left] = [true, true];
  else if (both === 'no' || both === 'none') [right, left] = [false, false];
  else if (both === 'right') [right, left] = [true, false];
  else if (both === 'left') [right, left] = [false, true];
  const each = sidewalkTag(tags['sidewalk:both']);
  if (each !== undefined) [right, left] = [each, each];
  right = sidewalkTag(tags['sidewalk:right']) ?? right;
  left = sidewalkTag(tags['sidewalk:left']) ?? left;
  return reverse ? { right: left, left: right } : { right, left };
}

/**
 * How wide a pavement OSM says is there is taken to be where the GRB cut no kerb (m): a
 * Flemish pavement's usual width.
 */
export const TAGGED_PAVEMENT = 1.8;

/**
 * A way's measured sides, with OSM's pavements where the GRB cut no kerb along it: a tagged
 * pavement puts the kerb a pavement's width in from the facade (what the open ground leaves),
 * a tagged lack of one puts it at the facade, so nobody walks there; a side the GRB measured,
 * or OSM says nothing about, stays as it is.
 */
export function sidesWithTags(sides: [Side, Side], tags: Sidewalks): [Side, Side] {
  return sides.map((side, i) => {
    const tagged = i === 0 ? tags.right : tags.left;
    if (side.kerb > 0 || tagged === undefined) return side;
    const kerb = tagged ? Math.max(side.edge - TAGGED_PAVEMENT, side.edge * 0.4) : side.edge;
    return { kerb: Math.round(kerb * 10) / 10, edge: side.edge };
  }) as [Side, Side];
}

/**
 * Which OSM ways carry traffic, and how. Links count with their road; service roads, tracks and
 * paths don't, nor does anything closed to motor vehicles unless it's a cycle track. Tunnels
 * and anything below ground stay out, as the map doesn't draw them.
 */
export function wayFromOsm(tags: Tags): WayStyle | null {
  const highway = (tags.highway ?? '').replace(/_link$/, '');
  if (tags.tunnel === 'yes' || Number(tags.layer) < 0 || tags.area === 'yes') return null;
  // Cycle tracks for bikes; pedestrian streets for people, and bikes too, as in Leuven.
  const kind: WayKind | null = MAIN.has(highway)
    ? 'main'
    : STREET.has(highway)
      ? 'street'
      : highway === 'cycleway'
        ? 'cycle'
        : highway === 'pedestrian'
          ? 'pedestrian'
          : PATH.has(highway)
            ? 'path'
            : null;
  if (!kind) return null;
  // Only paths of their own: not sidewalks and crossings, which lie on the road surface.
  if (kind === 'path' && (tags.footway === 'sidewalk' || tags.footway === 'crossing')) {
    return null;
  }
  // A road closed to cars (as `no`, `private`, a permit, deliveries or farm traffic, or a
  // Belgian F99 sign reserving it for walkers, cyclists and farm vehicles) carries none.
  const access = carAccess(tags);
  const closed =
    CLOSED_TO_CARS.has(access ?? '') ||
    CLOSED.has(tags.access ?? '') ||
    (tags.traffic_sign ?? '').includes('F99');
  if (closed && (kind === 'main' || kind === 'street')) return null;
  // A roundabout is one way round, whether or not it says so.
  const round = tags.junction === 'roundabout' || tags.junction === 'circular';
  const oneway = tags.oneway === 'yes' || tags.oneway === '-1' || (round && !tags.oneway);
  const reverse = tags.oneway === '-1';
  return {
    kind,
    oneway,
    reverse,
    bikesBoth: oneway && tags['oneway:bicycle'] === 'no',
    surface: surfaceOf(tags),
    sidewalks: sidewalksOf(tags, reverse),
    through: access !== 'destination' && tags.access !== 'destination',
    minor: highway === 'living_street',
  };
}

/**
 * Measures a way's two sides from its line: at three points along it, how far out the ground
 * is open (`open`: the road surface or a square, not a house) before a facade, and how far the
 * carriageway reaches (`carriageway`: the GRB's kerb-cut faces) before its kerb, each the
 * narrowest of the three, in steps of `step` up to `probe` metres. A line a little off its
 * carriageway (OSM's centre line beside the GRB's face) still finds it within a metre; past a
 * kerb the pavement is wherever the open ground goes on. Right is right of the way it runs.
 */
export function sidesOf(
  line: ArrayLike<number>,
  open: (x: number, z: number) => boolean,
  carriageway: (x: number, z: number) => boolean,
  probe = 12,
  step = 0.5,
): [right: Side, left: Side] {
  const sides: [Side, Side] = [
    { kerb: probe, edge: probe },
    { kerb: probe, edge: probe },
  ];
  for (const t of [0.15, 0.5, 0.85]) {
    const [x, z, dx, dz] = pointAlong(line, t);
    for (const [k, side] of [1, -1].entries()) {
      // Right of the heading in (x east, z south) is (-dz, dx).
      const at = (r: number, test: (x: number, z: number) => boolean) =>
        test(x - dz * side * r, z + dx * side * r);
      let edge = 0;
      while (edge < probe && at(edge + step, open)) edge += step;
      let kerb = 0;
      for (let r = 0, gap = 0; r <= edge; r += step) {
        if (at(r, carriageway)) [kerb, gap] = [r, 0];
        else if ((gap += step) > 1) break;
      }
      sides[k]!.edge = Math.min(sides[k]!.edge, edge);
      sides[k]!.kerb = Math.min(sides[k]!.kerb, kerb);
    }
  }
  return sides;
}

const key = (x: number, z: number) => `${x},${z}`;

/**
 * Splits polylines where they meet: at any point that ends a line or that two or more lines
 * share (an OSM node both ways pass through). The pieces keep their line's order, so a one-way
 * street's pieces still run its way. Points are compared exactly, as OSM's shared nodes are.
 */
export function splitAtJunctions<T extends { line: readonly number[] }>(
  lines: readonly T[],
): (Omit<T, 'line'> & { line: number[] })[] {
  const uses = new Map<string, number>();
  for (const { line } of lines) {
    const seen = new Set<string>();
    for (let i = 0; i + 1 < line.length; i += 2) {
      const k = key(line[i]!, line[i + 1]!);
      // A line through a point twice (a loop) meets itself there.
      if (seen.has(k) || i === 0 || i === line.length - 2) uses.set(k, (uses.get(k) ?? 0) + 2);
      else uses.set(k, (uses.get(k) ?? 0) + 1);
      seen.add(k);
    }
  }
  const out: (Omit<T, 'line'> & { line: number[] })[] = [];
  for (const way of lines) {
    const { line, ...rest } = way;
    let piece: number[] = [];
    for (let i = 0; i + 1 < line.length; i += 2) {
      const [x, z] = [line[i]!, line[i + 1]!];
      piece.push(x, z);
      const junction = (uses.get(key(x, z)) ?? 0) >= 2;
      if (junction && piece.length >= 4) {
        out.push({ ...rest, line: piece } as Omit<T, 'line'> & { line: number[] });
        piece = [x, z];
      }
    }
    if (piece.length >= 4)
      out.push({ ...rest, line: piece } as Omit<T, 'line'> & { line: number[] });
  }
  return out;
}

export interface RoadNode {
  x: number;
  z: number;
  /** The edges leaving it. */
  out: number[];
}

export interface RoadEdge {
  from: number;
  to: number;
  kind: WayKind;
  /** Flat [x0, z0, x1, z1, …], from `from` to `to`. */
  points: Float32Array;
  /** Distance along the edge at each point; the last is its length. */
  cum: Float32Array;
  length: number;
  /** Who may go this way: cars (and buses), bikes, people on foot. */
  cars: boolean;
  bikes: boolean;
  feet: boolean;
  surface: Surface;
  /** Either side of its line, right and left of the way it runs: its kerb and its facade. */
  right: Side;
  left: Side;
  /** Open to through traffic, and a living street (`Way`). */
  through: boolean;
  minor: boolean;
}

/** How wide the pavement on a side is (m): from the kerb to the facade, where there is a kerb. */
export const pavementOf = (side: Side): number =>
  side.kerb > 0 ? Math.max(0, side.edge - side.kerb) : 0;

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
}

/** Where a way's end lands, to the decimetre the file keeps, so pieces of one street meet. */
const nodeKey = (x: number, z: number) => `${Math.round(x * 10)},${Math.round(z * 10)}`;

/**
 * Joins the ways into a graph of directed edges: every way forward and backward, with who may
 * go that way: cars both ways on a two-way street and one way on a one-way one, bikes the same
 * (both ways on a cycle street, and on cycle tracks), people on foot every way on everything
 * but a main road with no pavement on either side (the ring's carriageways, a slip road). The
 * backward edge's right side is the way's left. Nodes are the ways' ends, met to the decimetre.
 */
export function roadGraph(ways: readonly Way[]): RoadGraph {
  const nodes: RoadNode[] = [];
  const edges: RoadEdge[] = [];
  const ids = new Map<string, number>();
  const nodeAt = (x: number, z: number) => {
    const k = nodeKey(x, z);
    let id = ids.get(k);
    if (id === undefined) {
      ids.set(k, (id = nodes.length));
      nodes.push({ x, z, out: [] });
    }
    return id;
  };
  const add = (
    points: Float32Array,
    way: Way,
    cars: boolean,
    bikes: boolean,
    feet: boolean,
    right: Side,
    left: Side,
  ): void => {
    const n = points.length / 2;
    if (n < 2) return;
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      cum[i] =
        cum[i - 1]! +
        Math.hypot(points[i * 2]! - points[i * 2 - 2]!, points[i * 2 + 1]! - points[i * 2 - 1]!);
    }
    const length = cum[n - 1]!;
    if (length < 0.5) return;
    const from = nodeAt(points[0]!, points[1]!);
    const to = nodeAt(points[n * 2 - 2]!, points[n * 2 - 1]!);
    nodes[from]!.out.push(edges.length);
    const { kind, surface, through, minor } = way;
    edges.push({
      from,
      to,
      kind,
      points,
      cum,
      length,
      cars,
      bikes,
      feet,
      surface,
      right,
      left,
      through,
      minor,
    });
  };
  for (const way of ways) {
    const cars = way.kind === 'main' || way.kind === 'street';
    const bikes = way.kind !== 'path';
    // A main road without a pavement is one nobody walks; without a kerb at all, the ground
    // is shared and the verge is walked.
    const kerbed = way.right.kerb > 0 || way.left.kerb > 0;
    const feet =
      way.kind !== 'main' ||
      !kerbed ||
      pavementOf(way.right) >= PAVEMENT ||
      pavementOf(way.left) >= PAVEMENT;
    add(way.line, way, cars, bikes, feet, way.right, way.left);
    const back = new Float32Array(way.line.length);
    for (let i = 0; i < way.line.length; i += 2) {
      back[i] = way.line[way.line.length - 2 - i]!;
      back[i + 1] = way.line[way.line.length - 1 - i]!;
    }
    const backBikes = bikes && (!way.oneway || way.bikesBoth);
    add(back, way, cars && !way.oneway, backBikes, feet, way.left, way.right);
  }
  return { nodes, edges };
}

/** A point along an edge, `s` metres from its start, and the way it heads there (unit). */
export function alongEdge(
  edge: RoadEdge,
  s: number,
  out: [number, number, number, number] = [0, 0, 0, 0],
): [number, number, number, number] {
  const { points, cum } = edge;
  const n = cum.length;
  const d = Math.min(Math.max(s, 0), edge.length);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const [ax, az, bx, bz] = [
    points[lo * 2]!,
    points[lo * 2 + 1]!,
    points[hi * 2]!,
    points[hi * 2 + 1]!,
  ];
  const len = cum[hi]! - cum[lo]! || 1;
  const t = (d - cum[lo]!) / len;
  out[0] = ax + (bx - ax) * t;
  out[1] = az + (bz - az) * t;
  out[2] = (bx - ax) / len;
  out[3] = (bz - az) / len;
  return out;
}

/** The turn from one edge's end into the next's start: 0 straight on, π back the way it came. */
export function turnBetween(a: RoadEdge, b: RoadEdge): number {
  const n = a.points.length;
  const [ax, az] = [a.points[n - 2]! - a.points[n - 4]!, a.points[n - 1]! - a.points[n - 3]!];
  const [bx, bz] = [b.points[2]! - b.points[0]!, b.points[3]! - b.points[1]!];
  const dot = (ax * bx + az * bz) / ((Math.hypot(ax, az) || 1) * (Math.hypot(bx, bz) || 1));
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

/**
 * A router over the road graph for one class of traffic: the cheapest way from a node to a
 * node along the edges it may take, by length times what each edge costs it a metre (`weight`,
 * 1 by default, never less, so the straight-line distance stays its guess).
 */
export function roadRouter(
  graph: RoadGraph,
  weight: (edge: number) => number = () => 1,
): GraphRouter {
  const { nodes, edges } = graph;
  return new GraphRouter({
    nodes: nodes.length,
    out: (node) => nodes[node]!.out,
    to: (edge) => edges[edge]!.to,
    cost: (edge) => edges[edge]!.length * weight(edge),
    estimate: (a, b) => Math.hypot(nodes[a]!.x - nodes[b]!.x, nodes[a]!.z - nodes[b]!.z),
  });
}

/**
 * The core of a class's network: the edges that stay connected to the rest when any one road
 * is taken away, less the small appendages. Every road is a link between its ends (a two-way
 * way once); the links whose loss would split the network (its bridges) are found, and what
 * they hang off the main body is kept only if it holds at least `least` metres of road: a
 * district behind one bridge is still a place to go, a lane into an abbey's grounds or a stub
 * to the map's edge is not. Spawning and destinations keep to the core, so the traffic flows
 * round the blocks rather than in and out of dead ends. A mask over the edges.
 */
export function coreEdges(
  graph: RoadGraph,
  allowed: (edge: number) => boolean,
  least: number,
): Uint8Array {
  const { nodes, edges } = graph;
  // One link per pair of ends: the first allowed edge between them names it.
  const link = new Int32Array(edges.length).fill(-1);
  const named = new Map<string, number>();
  const ends: [number, number][] = [];
  const length: number[] = [];
  const adjacency: number[][] = nodes.map(() => []);
  for (const [i, e] of edges.entries()) {
    if (!allowed(i)) continue;
    const pair = e.from < e.to ? `${e.from}>${e.to}` : `${e.to}>${e.from}`;
    let id = named.get(pair);
    if (id === undefined) {
      id = ends.push([e.from, e.to]) - 1;
      length.push(e.length);
      named.set(pair, id);
      adjacency[e.from]!.push(id);
      adjacency[e.to]!.push(id);
    }
    link[i] = id;
  }
  const other = (id: number, node: number) => (ends[id]![0] === node ? ends[id]![1] : ends[id]![0]);
  // Bridges, by Tarjan's lowpoints, without recursion.
  const disc = new Int32Array(nodes.length).fill(-1);
  const low = new Int32Array(nodes.length);
  const bridge = new Uint8Array(ends.length);
  let time = 0;
  for (let root = 0; root < nodes.length; root++) {
    if (disc[root] !== -1 || !adjacency[root]!.length) continue;
    const stack: [node: number, via: number, next: number][] = [[root, -1, 0]];
    disc[root] = low[root] = time++;
    while (stack.length) {
      const frame = stack.at(-1)!;
      const [node, via] = frame;
      if (frame[2] < adjacency[node]!.length) {
        const id = adjacency[node]![frame[2]++]!;
        if (id === via) continue;
        const next = other(id, node);
        if (disc[next] === -1) {
          disc[next] = low[next] = time++;
          stack.push([next, id, 0]);
        } else low[node] = Math.min(low[node]!, disc[next]!);
      } else {
        stack.pop();
        if (via < 0) continue;
        const parent = stack.at(-1)![0];
        low[parent] = Math.min(low[parent]!, low[node]!);
        if (low[node]! > disc[parent]!) bridge[via] = 1;
      }
    }
  }
  // What the bridges cut the network into, and how much road each piece holds.
  const piece = new Int32Array(nodes.length).fill(-1);
  const held: number[] = [];
  for (let root = 0; root < nodes.length; root++) {
    if (piece[root] !== -1 || !adjacency[root]!.length) continue;
    const id = held.push(0) - 1;
    const queue = [root];
    piece[root] = id;
    while (queue.length) {
      const node = queue.pop()!;
      for (const l of adjacency[node]!) {
        if (bridge[l]) continue;
        const next = other(l, node);
        if (piece[next] === -1) {
          piece[next] = id;
          queue.push(next);
        }
      }
    }
  }
  for (const [l, [a]] of ends.entries()) if (!bridge[l]) held[piece[a]!]! += length[l]!;
  const main = held.indexOf(Math.max(...held, 0));
  const core = new Uint8Array(edges.length);
  for (const [i, l] of link.entries()) {
    if (l < 0 || bridge[l]) continue;
    const p = piece[ends[l]![0]]!;
    if (p === main || held[p]! >= least) core[i] = 1;
  }
  return core;
}
