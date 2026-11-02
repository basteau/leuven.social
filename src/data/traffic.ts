import type { Way, WayKind } from './city.ts';
import { GraphRouter } from './graph-route.ts';

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
/** Where only bikes go: cycle tracks and pedestrian streets (open to bikes in Leuven). */
const CYCLE = new Set(['cycleway', 'pedestrian']);
const CLOSED = new Set(['no', 'private']);

export interface WayStyle {
  kind: WayKind;
  /** Traffic runs one way only, along the line as stored. */
  oneway: boolean;
  /** The stored line runs against OSM's: `oneway=-1`, so the bake turns the line round. */
  reverse: boolean;
  /** A one-way street bikes may ride both ways (`oneway:bicycle=no`, Leuven's cycle streets). */
  bikesBoth: boolean;
}

/**
 * Which OSM ways carry traffic, and how. Links count with their road; service roads, tracks and
 * paths don't, nor does anything closed to motor vehicles unless it's a cycle track. Tunnels
 * and anything below ground stay out, as the map doesn't draw them.
 */
export function wayFromOsm(tags: Tags): WayStyle | null {
  const highway = (tags.highway ?? '').replace(/_link$/, '');
  if (tags.tunnel === 'yes' || Number(tags.layer) < 0 || tags.area === 'yes') return null;
  const kind: WayKind | null = MAIN.has(highway)
    ? 'main'
    : STREET.has(highway)
      ? 'street'
      : CYCLE.has(highway)
        ? 'cycle'
        : PATH.has(highway)
          ? 'path'
          : null;
  if (!kind) return null;
  // Only paths of their own: not sidewalks and crossings, which lie on the road surface.
  if (kind === 'path' && (tags.footway === 'sidewalk' || tags.footway === 'crossing')) {
    return null;
  }
  const closed = CLOSED.has(tags.motor_vehicle ?? '') || CLOSED.has(tags.access ?? '');
  if (closed && (kind === 'main' || kind === 'street')) return null;
  // A roundabout is one way round, whether or not it says so.
  const round = tags.junction === 'roundabout' || tags.junction === 'circular';
  const oneway = tags.oneway === 'yes' || tags.oneway === '-1' || (round && !tags.oneway);
  return {
    kind,
    oneway,
    reverse: tags.oneway === '-1',
    bikesBoth: oneway && tags['oneway:bicycle'] === 'no',
  };
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
  /** Half the open ground across it (m): how far out lanes and pavements may lie. */
  halfWidth: number;
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
}

/** Where a way's end lands, to the decimetre the file keeps, so pieces of one street meet. */
const nodeKey = (x: number, z: number) => `${Math.round(x * 10)},${Math.round(z * 10)}`;

/**
 * Joins the ways into a graph of directed edges: every way forward and backward, with who may
 * go that way: cars both ways on a two-way street and one way on a one-way one, bikes the same
 * (both ways on a cycle street, and on cycle tracks), people on foot every way on everything,
 * paths included. Nodes are the ways' ends, met to the decimetre.
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
  const add = (points: Float32Array, way: Way, cars: boolean, bikes: boolean): void => {
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
    const { kind, halfWidth } = way;
    edges.push({ from, to, kind, points, cum, length, cars, bikes, feet: true, halfWidth });
  };
  for (const way of ways) {
    const cars = way.kind === 'main' || way.kind === 'street';
    const bikes = way.kind !== 'path';
    add(way.line, way, cars, bikes);
    const back = new Float32Array(way.line.length);
    for (let i = 0; i < way.line.length; i += 2) {
      back[i] = way.line[way.line.length - 2 - i]!;
      back[i + 1] = way.line[way.line.length - 1 - i]!;
    }
    add(back, way, cars && !way.oneway, bikes && (!way.oneway || way.bikesBoth));
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
 * A router over the road graph for one class of traffic: the shortest way from a node to a
 * node along the edges it may take, by length, with the straight-line distance as its guess.
 */
export function roadRouter(graph: RoadGraph): GraphRouter {
  const { nodes, edges } = graph;
  return new GraphRouter({
    nodes: nodes.length,
    out: (node) => nodes[node]!.out,
    to: (edge) => edges[edge]!.to,
    cost: (edge) => edges[edge]!.length,
    estimate: (a, b) => Math.hypot(nodes[a]!.x - nodes[b]!.x, nodes[a]!.z - nodes[b]!.z),
  });
}
