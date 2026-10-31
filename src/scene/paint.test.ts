import { describe, expect, test } from 'bun:test';

import type { Marking } from '../data/city.ts';
import { MeshBuilder } from './mesh-builder.ts';
import {
  ANGLES,
  PAINT_HALF,
  PAINT_KIND,
  addFinePaint,
  addPaint,
  paintCode,
  readPaint,
} from './paint.ts';
import { PAINT } from './palette.ts';

const line = (...xz: number[]) => new Float32Array(xz);

function draw(add: typeof addPaint, markings: Marking[]) {
  const mesh = new MeshBuilder();
  add(mesh, markings);
  const g = mesh.build({ facade: true });
  const p = g.getAttribute('position');
  const f = g.getAttribute('facade');
  return Array.from({ length: p.count }, (_, i) => ({
    x: p.getX(i),
    y: p.getY(i),
    z: p.getZ(i),
    code: f.getX(i),
  }));
}

describe('paint codes', () => {
  test('round-trip kind, direction and side, folding opposite directions onto one axis', () => {
    for (const [nx, nz] of [
      [1, 0],
      [0, 1],
      [Math.SQRT1_2, -Math.SQRT1_2],
      [-1, 0],
      [-0.6, -0.8],
    ] as const) {
      for (const side of [0, 1] as const) {
        const read = readPaint(paintCode('line', nx, nz, side));
        expect(read.kind).toBe(PAINT_KIND.line);
        // The vertex sits on side ±1 along the stored direction: the same point either way.
        const sign = side ? 1 : -1;
        expect(read.nx * read.side).toBeCloseTo(nx * sign, 2);
        expect(read.nz * read.side).toBeCloseTo(nz * sign, 2);
      }
    }
  });

  test('codes stay negative integers inside their kind', () => {
    for (const kind of Object.keys(PAINT_KIND) as (keyof typeof PAINT_KIND)[]) {
      const code = paintCode(kind, 0.3, 0.95, 1);
      expect(Number.isInteger(code)).toBe(true);
      expect(Math.floor(-code / (ANGLES * 2))).toBe(PAINT_KIND[kind]);
    }
  });
});

describe('paint geometry', () => {
  test('a dashed line keeps its 3 m on, 6 m off rhythm around a bend', () => {
    // 10 m east, then 10 m south: dashes at 0–3 and 9–12 (split by the bend) and 18–20.
    const v = draw(addFinePaint, [{ kind: 'dashed', line: line(0, 0, 10, 0, 10, 10) }]);
    expect(v).toHaveLength(4 * 6);
    expect(v.every((p) => p.y === Math.fround(0.17))).toBe(true);
    const xs = v.filter((p) => Math.abs(p.z) < 0.1).map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(xs.some((x) => Math.abs(x - 3) < 1e-6)).toBe(true);
    expect(xs.some((x) => Math.abs(x - 9) < 1e-6)).toBe(true);
    // Lines are as wide as paint until the shader widens them.
    const widths = v.filter((p) => p.x < 4).map((p) => p.z);
    expect(Math.max(...widths) - Math.min(...widths)).toBeCloseTo(2 * PAINT_HALF.line);
  });

  test('a solid line runs on past its ends so bends close up', () => {
    const v = draw(addFinePaint, [{ kind: 'solid', line: line(0, 0, 10, 0) }]);
    expect(v).toHaveLength(6);
    expect(Math.min(...v.map((p) => p.x))).toBeCloseTo(-0.3);
    expect(Math.max(...v.map((p) => p.x))).toBeCloseTo(10.3);
  });

  test('a zebra: a grey patch everywhere, bars up close', () => {
    const zebra: Marking = { kind: 'zebra', line: line(0, 0, 0, 7) };
    const patch = draw(addPaint, [zebra]);
    expect(patch).toHaveLength(6);
    expect(patch.every((p) => p.y === Math.fround(0.16))).toBe(true);
    expect(new Set(patch.map((p) => Math.floor(-p.code / (ANGLES * 2))))).toEqual(
      new Set([PAINT_KIND.patch]),
    );
    // 7 m across the road: seven bars, centred, 2 m either side of the crossing's line.
    const bars = draw(addFinePaint, [zebra]);
    expect(bars).toHaveLength(7 * 6);
    expect(Math.min(...bars.map((p) => p.z))).toBeCloseTo(0.25);
    expect(Math.max(...bars.map((p) => p.z))).toBeCloseTo(6.75);
    expect(Math.max(...bars.map((p) => Math.abs(p.x)))).toBeCloseTo(PAINT_HALF.stripe);
  });

  test('a cyclist crossing: a red band, edged by blocks up close', () => {
    const bike: Marking = { kind: 'bike-crossing', line: line(0, 0, 5, 0) };
    const band = draw(addPaint, [bike]);
    expect(band).toHaveLength(6);
    expect(band.every((p) => p.code === -1)).toBe(true);
    const blocks = draw(addFinePaint, [bike]);
    // Blocks at 0.25, 1.25, … 4.25 m along, in two rows.
    expect(blocks).toHaveLength(2 * 5 * 6);
    expect(new Set(blocks.map((p) => Math.round(Math.abs(p.z) * 4) / 4))).toEqual(
      new Set([0.75, 1.25]),
    );
  });

  test('cycle lanes are red ribbons; crossings too short or lines too short draw nothing', () => {
    const v = draw(addPaint, [{ kind: 'cycle-lane', line: line(0, 0, 10, 0, 10, 0) }]);
    expect(v).toHaveLength(6);
    expect(Math.max(...v.map((p) => p.x))).toBeCloseTo(10.75);
    const nothing: Marking[] = [
      { kind: 'zebra', line: line(0, 0, 0, 0.5) },
      { kind: 'bike-crossing', line: line(0, 0, 0, 0) },
      { kind: 'dashed', line: line(0, 0, 0.1, 0) },
      { kind: 'dashed', line: line(0, 0) },
    ];
    expect(draw(addPaint, nothing)).toHaveLength(0);
    expect(draw(addFinePaint, nothing)).toHaveLength(0);
    expect(PAINT.bike).toBeGreaterThan(0);
  });
});
