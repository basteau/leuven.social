import { describe, expect, test } from 'bun:test';

import { GraphRouter } from './graph-route.ts';
import type { Graph } from './graph-route.ts';

/** A grid of nodes `w` wide, edges to the right and down (and back), each of cost 1. */
function grid(w: number, h: number): Graph & { edgesOf: [number, number][] } {
  const edgesOf: [number, number][] = [];
  const out: number[][] = Array.from({ length: w * h }, () => []);
  const link = (a: number, b: number) => {
    out[a]!.push(edgesOf.push([a, b]) - 1);
    out[b]!.push(edgesOf.push([b, a]) - 1);
  };
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (c + 1 < w) link(r * w + c, r * w + c + 1);
      if (r + 1 < h) link(r * w + c, (r + 1) * w + c);
    }
  }
  return {
    edgesOf,
    nodes: w * h,
    out: (n) => out[n]!,
    to: (e) => edgesOf[e]![1],
    cost: () => 1,
    estimate: (a, b) =>
      Math.abs((a % w) - (b % w)) + Math.abs(Math.floor(a / w) - Math.floor(b / w)),
  };
}

const any = () => true;

describe('GraphRouter', () => {
  test('finds a shortest route, as edges in order, and reuses its arrays between searches', () => {
    const g = grid(10, 10);
    const router = new GraphRouter(g);
    const route = router.route(0, 99, any)!;
    expect(route).toHaveLength(18);
    let at = 0;
    for (const e of route) {
      expect(g.edgesOf[e]![0]).toBe(at);
      at = g.edgesOf[e]![1];
    }
    expect(at).toBe(99);
    expect(router.route(99, 0, any)).toHaveLength(18);
    expect(router.route(5, 5, any)).toEqual([]);
  });

  test('keeps to allowed edges, and gives up past the most it may cost', () => {
    const g = grid(5, 5);
    const router = new GraphRouter(g);
    // Only edges heading right or down: still a route from the corner, none back.
    const forward = (e: number) => g.edgesOf[e]![1] > g.edgesOf[e]![0];
    expect(router.route(0, 24, forward)).toHaveLength(8);
    expect(router.route(24, 0, forward)).toBeNull();
    expect(router.route(0, 24, any, 7)).toBeNull();
    expect(router.route(0, 24, any, 8)).toHaveLength(8);
  });

  test('as Dijkstra, with no estimate, it finds the same length', () => {
    const g = grid(8, 3);
    const router = new GraphRouter({ ...g, estimate: () => 0 });
    expect(router.route(0, 23, any)).toHaveLength(9);
  });
});
