/**
 * Straight skeleton of a footprint, the geometry of a hipped roof over any shape: every wall
 * edge raises a roof face that climbs inward at the same slope, and faces meet in hips, valleys
 * and ridges. Wavefront simulation after Felkel & Obdržálek (1998): edge events when a shrinking
 * edge vanishes, split events when a reflex corner runs into an opposite edge (which also joins a
 * courtyard's wavefront to the outer one). Returns null instead of a wrong roof when the input
 * defeats it, so the caller can fall back to a flat one.
 */

/** One roof face: the polygon over one footprint edge, as flat [x, z, t, …] triples. */
export interface SkeletonFace {
  /** Index of its footprint edge, counting the outer ring first, then each hole. */
  edge: number;
  /** t is how far the wavefront had moved inward there: 0 on the footprint, most at the ridge. */
  points: number[];
}

/** One interior hip, valley or ridge line, as [x0, z0, t0, x1, z1, t1]. */
export type SkeletonArc = [number, number, number, number, number, number];

export interface Skeleton {
  faces: SkeletonFace[];
  arcs: SkeletonArc[];
  /** The largest t: half the width of the widest part. */
  height: number;
}

const EPS = 1e-7;

interface Edge {
  ax: number;
  az: number;
  /** Unit direction a→b and inward unit normal; the edge's line at time t is n·p = c + t. */
  dx: number;
  dz: number;
  nx: number;
  nz: number;
  c: number;
}

interface Vertex {
  x: number;
  z: number;
  t: number;
  /** The edge arriving here and the edge leaving. */
  left: number;
  right: number;
  vx: number;
  vz: number;
  /** Its two edges are antiparallel and already touch: it has no direction of its own. */
  instant: boolean;
  reflex: boolean;
  prev: Vertex;
  next: Vertex;
  active: boolean;
  node: number;
}

type SkeletonEvent =
  | { t: number; kind: 'edge'; a: Vertex; b: Vertex }
  | { t: number; kind: 'split'; v: Vertex; edge: number; x: number; z: number };

/** A plain binary min-heap on event time. */
class Queue {
  #items: SkeletonEvent[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(item: SkeletonEvent): void {
    const a = this.#items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.t <= a[i]!.t) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }

  pop(): SkeletonEvent {
    const a = this.#items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.t < a[m]!.t) m = l;
        if (r < a.length && a[r]!.t < a[m]!.t) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

function toEdges(rings: readonly ArrayLike<number>[]): { edges: Edge[]; starts: number[] } {
  const edges: Edge[] = [];
  const starts: number[] = [];
  for (const ring of rings) {
    starts.push(edges.length);
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = ring[i * 2]!;
      const az = ring[i * 2 + 1]!;
      const bx = ring[((i + 1) % n) * 2]!;
      const bz = ring[((i + 1) % n) * 2 + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      // Outer ring counter-clockwise, holes clockwise: the inside is always on the left.
      const nx = -dz;
      const nz = dx;
      edges.push({ ax, az, dx, dz, nx, nz, c: nx * ax + nz * az });
    }
  }
  return { edges, starts };
}

/**
 * The straight skeleton of a polygon: `outer` counter-clockwise and `holes` clockwise in (x, z),
 * flat [x0, z0, …] rings without a closing point.
 *
 * Symmetric shapes make several events land on one point at one instant, which the event order
 * can resolve wrongly. Every result is checked (its faces must tile the footprint), and a failed
 * one is retried with the corners nudged by a few millimetres, which breaks the ties.
 */
export function straightSkeleton(
  outer: ArrayLike<number>,
  holes: readonly ArrayLike<number>[] = [],
): Skeleton | null {
  const rings = [outer, ...holes];
  if (rings.some((r) => r.length < 6)) return null;
  const area = rings.reduce((sum, r) => sum + ringArea(r), 0);
  if (!(area > 0)) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const nudged = attempt
      ? rings.map((r) =>
          Array.from(r, (v, i) => v + 0.004 * Math.sin(i * 12.9898 + attempt * 78.233)),
        )
      : rings;
    const skeleton = skeletonOf(nudged);
    if (!skeleton) continue;
    const tiled = skeleton.faces.reduce((sum, f) => sum + Math.abs(ringArea(planOf(f.points))), 0);
    if (Math.abs(tiled - area) <= area * 1e-3 + 1e-6) return skeleton;
  }
  return null;
}

function ringArea(ring: ArrayLike<number>): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    sum += ring[i]! * ring[j + 1]! - ring[j]! * ring[i + 1]!;
  }
  return sum / 2;
}

const planOf = (points: readonly number[]) => points.filter((_, i) => i % 3 !== 2);

function skeletonOf(rings: readonly ArrayLike<number>[]): Skeleton | null {
  const { edges, starts } = toEdges(rings);
  if (edges.some((e) => !Number.isFinite(e.dx))) return null;

  const nodes: number[] = []; // x, z, t triples
  const node = (x: number, z: number, t: number) => {
    nodes.push(x, z, t);
    return nodes.length / 3 - 1;
  };
  const arcs: { from: number; to: number; left: number; right: number }[] = [];
  // Active vertices by the edge leaving them: where a split event looks for the edge it hits.
  const byRight = new Map<number, Set<Vertex>>();
  const end = (v: Vertex, to: number) => {
    v.active = false;
    byRight.get(v.right)?.delete(v);
    arcs.push({ from: v.node, to, left: v.left, right: v.right });
  };
  const at = (v: Vertex, t: number): [number, number] =>
    v.instant ? [v.x, v.z] : [v.x + v.vx * (t - v.t), v.z + v.vz * (t - v.t)];

  const makeVertex = (x: number, z: number, t: number, left: number, right: number, id: number) => {
    const l = edges[left]!;
    const r = edges[right]!;
    const det = l.nx * r.nz - l.nz * r.nx;
    let vx = 0;
    let vz = 0;
    let instant = false;
    if (Math.abs(det) > 1e-9) {
      vx = (r.nz - l.nz) / det;
      vz = (l.nx - r.nx) / det;
    } else if (l.nx * r.nx + l.nz * r.nz > 0) {
      vx = l.nx;
      vz = l.nz;
    } else {
      instant = true;
    }
    const reflex = !instant && l.dx * r.dz - l.dz * r.dx < -1e-9;
    const v = { x, z, t, left, right, vx, vz, instant, reflex, active: true, node: id } as Vertex;
    v.prev = v;
    v.next = v;
    if (!byRight.has(right)) byRight.set(right, new Set());
    byRight.get(right)!.add(v);
    return v;
  };

  /** The live wavefront segment of `edge` that (x, z) lies on at time t, if any. */
  const segmentAt = (edge: number, t: number, x: number, z: number, v: Vertex) => {
    const e = edges[edge]!;
    for (const a of byRight.get(edge) ?? []) {
      if (a === v || a.next === v) continue;
      const [x0, z0] = at(a, t);
      const [x1, z1] = at(a.next, t);
      const u = (x - x0) * e.dx + (z - z0) * e.dz;
      const len = (x1 - x0) * e.dx + (z1 - z0) * e.dz;
      if (u >= -1e-6 && u <= len + 1e-6) return a;
    }
    return undefined;
  };

  const queue = new Queue();
  const vertices: Vertex[] = [];

  const edgeEvent = (a: Vertex, b: Vertex) => {
    let t: number;
    if (a.instant || b.instant) {
      t = Math.max(a.t, b.t);
    } else {
      const e = edges[a.right]!;
      const k = (b.vx - a.vx) * e.dx + (b.vz - a.vz) * e.dz;
      if (k > -EPS) return;
      const s0 =
        (b.x - a.x) * e.dx +
        (b.z - a.z) * e.dz -
        (b.vx * e.dx + b.vz * e.dz) * b.t +
        (a.vx * e.dx + a.vz * e.dz) * a.t;
      t = -s0 / k;
      if (t < Math.max(a.t, b.t) - 1e-6) return;
    }
    queue.push({ t, kind: 'edge', a, b });
  };

  const splitEvents = (v: Vertex) => {
    if (!v.reflex) return;
    for (const [i, e] of edges.entries()) {
      if (i === v.left || i === v.right) continue;
      const along = e.nx * v.vx + e.nz * v.vz;
      const denom = 1 - along;
      if (denom < EPS) continue;
      const gap = e.nx * v.x + e.nz * v.z - e.c - v.t;
      if (gap <= 1e-6) continue; // the edge's line is behind this corner, or already on it
      const t = v.t + gap / denom;
      const x = v.x + v.vx * (t - v.t);
      const z = v.z + v.vz * (t - v.t);
      // Only edges whose wavefront is there now; the event is checked again when it comes up.
      if (segmentAt(i, t, x, z, v)) queue.push({ t, kind: 'split', v, edge: i, x, z });
    }
  };

  const schedule = (v: Vertex) => {
    edgeEvent(v.prev, v);
    edgeEvent(v, v.next);
    splitEvents(v);
  };

  for (const [r, ring] of rings.entries()) {
    const n = ring.length / 2;
    const first = starts[r]!;
    const loop: Vertex[] = [];
    for (let i = 0; i < n; i++) {
      const id = node(ring[i * 2]!, ring[i * 2 + 1]!, 0);
      loop.push(
        makeVertex(ring[i * 2]!, ring[i * 2 + 1]!, 0, first + ((i + n - 1) % n), first + i, id),
      );
    }
    for (const [i, v] of loop.entries()) {
      v.next = loop[(i + 1) % n]!;
      v.prev = loop[(i + n - 1) % n]!;
    }
    vertices.push(...loop);
  }
  for (const v of vertices) schedule(v);

  /** Closes a loop that has shrunk to two vertices: they meet in one last ridge line. */
  const closeIfTiny = (v: Vertex): boolean => {
    if (v.next.next !== v) return false;
    const other = v.next;
    end(other, v.node);
    v.active = false;
    return true;
  };

  let budget = 50 * edges.length * edges.length + 1000;
  while (queue.size) {
    if (--budget < 0) return null;
    const ev = queue.pop();
    if (ev.kind === 'edge') {
      const { a, b } = ev;
      if (!a.active || !b.active || a.next !== b) continue;
      const [ax, az] = at(a, ev.t);
      const [bx, bz] = at(b, ev.t);
      const [x, z] = a.instant ? [bx, bz] : b.instant ? [ax, az] : [(ax + bx) / 2, (az + bz) / 2];
      const p = node(x, z, ev.t);
      const before = a.prev;
      const after = b.next;
      end(a, p);
      end(b, p);
      if (before === b) continue; // the loop was just these two
      if (before === after) {
        end(before, p); // a triangle collapses to a point
        continue;
      }
      const w = makeVertex(x, z, ev.t, a.left, b.right, p);
      before.next = w;
      w.prev = before;
      w.next = after;
      after.prev = w;
      vertices.push(w);
      if (!closeIfTiny(w)) schedule(w);
    } else {
      const { v } = ev;
      if (!v.active) continue;
      const hit = segmentAt(ev.edge, ev.t, ev.x, ev.z, v);
      if (!hit) continue;
      const p = node(ev.x, ev.z, ev.t);
      const before = v.prev;
      const after = v.next;
      const y = hit.next;
      end(v, p);
      const w1 = makeVertex(ev.x, ev.z, ev.t, v.left, ev.edge, p);
      const w2 = makeVertex(ev.x, ev.z, ev.t, ev.edge, v.right, p);
      before.next = w1;
      w1.prev = before;
      w1.next = y;
      y.prev = w1;
      hit.next = w2;
      w2.prev = hit;
      w2.next = after;
      after.prev = w2;
      vertices.push(w1, w2);
      for (const w of [w1, w2]) if (!closeIfTiny(w)) schedule(w);
    }
  }
  if (vertices.some((v) => v.active)) return null;

  // Each face is bounded by its edge and the arcs on either side of it: walk them end to start.
  const faces: SkeletonFace[] = [];
  for (const [r, ring] of rings.entries()) {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const edge = starts[r]! + i;
      const startNode = starts[r]! + i;
      const endNode = starts[r]! + ((i + 1) % n);
      const links = new Map<number, number[]>();
      const link = (a: number, b: number) => links.set(a, [...(links.get(a) ?? []), b]);
      for (const arc of arcs) {
        if (arc.left !== edge && arc.right !== edge) continue;
        link(arc.from, arc.to);
        link(arc.to, arc.from);
      }
      // Breadth-first: the shortest chain of arcs, which skips any zero-length detours.
      const from = new Map<number, number>([[endNode, -1]]);
      const queueNodes = [endNode];
      while (queueNodes.length && !from.has(startNode)) {
        const cur = queueNodes.shift()!;
        for (const nb of links.get(cur) ?? []) {
          if (from.has(nb) || (cur === endNode && nb === startNode)) continue;
          from.set(nb, cur);
          queueNodes.push(nb);
        }
      }
      if (!from.has(startNode)) return null;
      const path: number[] = [];
      for (let cur = from.get(startNode)!; cur !== endNode; cur = from.get(cur)!) path.push(cur);
      const ids = [startNode, endNode, ...path.toReversed()];
      faces.push({ edge, points: ids.flatMap((id) => nodes.slice(id * 3, id * 3 + 3)) });
    }
  }

  let height = 0;
  for (let i = 2; i < nodes.length; i += 3) height = Math.max(height, nodes[i]!);
  return {
    faces,
    arcs: arcs
      .filter((a) => a.from !== a.to)
      .map((a) =>
        nodes.slice(a.from * 3, a.from * 3 + 3).concat(nodes.slice(a.to * 3, a.to * 3 + 3)),
      )
      .filter((a) => Math.hypot(a[0]! - a[3]!, a[1]! - a[4]!) > 1e-6) as SkeletonArc[],
    height,
  };
}
