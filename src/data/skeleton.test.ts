import { describe, expect, test } from 'bun:test';

import { signedArea } from './geometry.ts';
import { straightSkeleton } from './skeleton.ts';
import type { Skeleton } from './skeleton.ts';

const rect = (x: number, z: number, w: number, d: number) => [
  x,
  z,
  x + w,
  z,
  x + w,
  z + d,
  x,
  z + d,
];
const reverse = (ring: number[]) => {
  const out: number[] = [];
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i]!, ring[i + 1]!);
  return out;
};

/** The faces must tile the footprint exactly: no gaps, no overlaps. */
function planArea(s: Skeleton): number {
  return s.faces.reduce((sum, f) => {
    const flat = f.points.filter((_, i) => i % 3 !== 2);
    return sum + Math.abs(signedArea(flat));
  }, 0);
}

/** Every face point sits at distance t from its own edge's line. */
function expectConsistent(s: Skeleton, rings: number[][]): void {
  const edges = rings.flatMap((ring) =>
    Array.from({ length: ring.length / 2 }, (_, i) => {
      const n = ring.length / 2;
      const [ax, az, bx, bz] = [
        ring[i * 2]!,
        ring[i * 2 + 1]!,
        ring[((i + 1) % n) * 2]!,
        ring[((i + 1) % n) * 2 + 1]!,
      ];
      const len = Math.hypot(bx - ax, bz - az);
      return { ax, az, nx: -(bz - az) / len, nz: (bx - ax) / len };
    }),
  );
  for (const f of s.faces) {
    const e = edges[f.edge]!;
    for (let i = 0; i < f.points.length; i += 3) {
      const d = (f.points[i]! - e.ax) * e.nx + (f.points[i + 1]! - e.az) * e.nz;
      expect(d).toBeCloseTo(f.points[i + 2]!, 4);
    }
  }
}

describe('straight skeleton', () => {
  test('a rectangle gets a hipped roof with one ridge', () => {
    const ring = rect(0, 0, 10, 4);
    const s = straightSkeleton(ring)!;
    expect(s.height).toBeCloseTo(2);
    expect(s.faces).toHaveLength(4);
    expect(planArea(s)).toBeCloseTo(40);
    const ridge = s.arcs.find((a) => a[2] === 2 && a[5] === 2)!;
    expect([ridge[0], ridge[3]].toSorted((a, b) => a - b)).toEqual([2, 8]);
    expectConsistent(s, [ring]);
  });

  test('a square becomes a pyramid', () => {
    const ring = rect(0, 0, 6, 6);
    const s = straightSkeleton(ring)!;
    expect(s.height).toBeCloseTo(3);
    expect(planArea(s)).toBeCloseTo(36);
    const apexes = s.faces.flatMap((f) => f.points.filter((_, i) => i % 3 === 2));
    expect(Math.max(...apexes)).toBeCloseTo(3);
  });

  test('an L-shape gets a valley at its inside corner', () => {
    const ring = [0, 0, 12, 0, 12, 4, 4, 4, 4, 10, 0, 10];
    const s = straightSkeleton(ring)!;
    expect(s.height).toBeCloseTo(2);
    expect(planArea(s)).toBeCloseTo(12 * 4 + 4 * 6);
    expectConsistent(s, [ring]);
  });

  test('a T and a U split around their reflex corners', () => {
    const t = [0, 0, 20, 0, 20, 6, 13, 6, 13, 16, 7, 16, 7, 6, 0, 6];
    const u = [0, 0, 18, 0, 18, 14, 13, 14, 13, 5, 5, 5, 5, 14, 0, 14];
    for (const ring of [t, u]) {
      const s = straightSkeleton(ring)!;
      expect(planArea(s)).toBeCloseTo(signedArea(ring), 1);
    }
    // The T is perfectly symmetric: only nudging its corners resolves it, a few mm off.
    expectConsistent(straightSkeleton(u)!, [u]);
  });

  test('a block with a courtyard rises from both its outer walls and the courtyard', () => {
    const outer = rect(0, 0, 30, 20);
    const hole = reverse(rect(8, 6, 14, 8));
    const s = straightSkeleton(outer, [hole])!;
    expect(s.faces).toHaveLength(8);
    // The 6 m sides close first; the 8 m ones keep rising to a ridge at 4.
    expect(s.height).toBeCloseTo(4);
    expect(planArea(s)).toBeCloseTo(600 - 112, 3);
    expectConsistent(s, [outer, hole]);
  });

  test('irregular footprints still tile exactly', () => {
    const rings = [
      [0, 0, 9, 1, 11, 7, 6, 5, 3, 9, -1, 6],
      [0, 0, 5, 0, 5, 3, 7, 3, 7, 0, 12, 0, 12, 8, 0, 8],
      [0, 0, 10, 0, 10, 10, 9, 10, 9, 1, 1, 1, 1, 10, 0, 10],
    ];
    for (const ring of rings) {
      const s = straightSkeleton(ring)!;
      expect(s).not.toBeNull();
      expect(planArea(s)).toBeCloseTo(signedArea(ring), 3);
      expectConsistent(s, [ring]);
    }
  });

  test('refuses rings it cannot use', () => {
    expect(straightSkeleton([0, 0, 1, 1])).toBeNull();
    expect(straightSkeleton([0, 0, 0, 0, 1, 1])).toBeNull();
    expect(straightSkeleton(reverse(rect(0, 0, 4, 4)))).toBeNull();
  });
});
