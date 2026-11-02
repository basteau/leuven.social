import { describe, expect, test } from 'bun:test';

import { unpackCity } from '../data/format.ts';
import { LANE } from '../data/pitches.ts';
import { Terrain } from '../data/terrain.ts';
import type { Field } from '../data/pitches.ts';
import type { Marking } from './paint.ts';
import { MeshBuilder, unindexed } from './mesh-builder.ts';
import {
  ANGLES,
  PAINT_GRADE,
  PAINT_HALF,
  PAINT_KIND,
  addFieldLines,
  addFinePaint,
  addPaint,
  fieldLines,
  paintCode,
  readPaint,
} from './paint.ts';
import { PAINT } from './palette.ts';

const line = (...xz: number[]) => new Float32Array(xz);

test('widened lines are lifted enough for the steepest ground in public/data/city.bin', async () => {
  const response = await fetch(new URL('../../public/data/city.bin', import.meta.url));
  const city = await unpackCity(new Uint8Array(await response.arrayBuffer()));
  const { steepest } = new Terrain(city.terrain);
  expect(steepest).toBeGreaterThan(0.05);
  expect(steepest).toBeLessThanOrEqual(PAINT_GRADE);
});

function draw(add: typeof addPaint, markings: Marking[]) {
  const mesh = new MeshBuilder();
  add(mesh, markings);
  const g = unindexed(mesh.build({ facade: true }));
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

  test('a piece of a dashed line picks up the rhythm where it starts along the whole line', () => {
    // 4 m in: the first dash (0–3 m) is past, the next starts 5 m into the piece.
    const v = draw(addFinePaint, [{ kind: 'dashed', line: line(0, 0, 10, 0), from: 4 }]);
    expect(v).toHaveLength(6);
    expect(Math.min(...v.map((p) => p.x))).toBeCloseTo(5);
    expect(Math.max(...v.map((p) => p.x))).toBeCloseTo(8);
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

const field = (over: Partial<Field>): Field => ({
  sport: 'soccer',
  x: 0,
  z: 0,
  angle: 0,
  length: 107,
  width: 70,
  count: 1,
  ...over,
});
/** Segments as [x0, z0, x1, z1]. */
const segs = (f: Field) => {
  const flat = fieldLines(f);
  return Array.from({ length: flat.length / 4 }, (_, i) => flat.slice(i * 4, i * 4 + 4));
};
const has = (f: Field, x0: number, z0: number, x1: number, z1: number) =>
  segs(f).some((s) => [x0, z0, x1, z1].every((v, i) => Math.abs(s[i]! - v) < 1e-6));

describe('pitch lines', () => {
  test('a full-size soccer field: touchlines a metre in, halfway line, FIFA boxes', () => {
    const f = field({});
    expect(has(f, -52.5, -34, 52.5, -34)).toBe(true);
    expect(has(f, 0, -34, 0, 34)).toBe(true);
    // The penalty area's front, 16.5 m out and 40.32 m wide; the goal area's, 5.5 m out.
    expect(has(f, 36, -20.16, 36, 20.16)).toBe(true);
    expect(has(f, -47, -9.16, -47, 9.16)).toBe(true);
    // Everything lies inside the touchlines.
    const pts = fieldLines(f);
    for (let i = 0; i < pts.length; i += 2) {
      expect(Math.abs(pts[i]!)).toBeLessThanOrEqual(52.5 + 1e-9);
      expect(Math.abs(pts[i + 1]!)).toBeLessThanOrEqual(34 + 1e-9);
    }
    // The penalty arcs lie outside the penalty areas.
    const arcs = segs(f).filter((s) => Math.abs(Math.hypot(s[0]! - 41.5, s[1]!) - 9.15) < 1e-6);
    expect(arcs.length).toBeGreaterThan(2);
    expect(arcs.every((s) => s[0]! <= 36 + 1e-6 && s[2]! <= 36 + 1e-6)).toBe(true);
  });

  test('a small soccer field scales its boxes and circle down with it', () => {
    const f = field({ length: 47, width: 27 });
    const s = 25 / 50;
    expect(has(f, 22.5 - 16.5 * s, -20.16 * s, 22.5 - 16.5 * s, 20.16 * s)).toBe(true);
  });

  test('turned with the field, about its centre', () => {
    const f = field({ x: 10, z: 20, angle: Math.PI / 2 });
    // The touchline now runs along z, 34 m east of the centre.
    expect(has(f, 10 + 34, 20 - 52.5, 10 + 34, 20 + 52.5)).toBe(true);
  });

  test('tennis courts side by side, each with its singles lines, service boxes and net', () => {
    const f = field({ sport: 'tennis', length: 36, width: 36, count: 2 });
    expect(segs(f)).toHaveLength(2 * 10);
    for (const v of [-9, 9]) {
      expect(has(f, -11.885, v - 5.485, 11.885, v - 5.485)).toBe(true);
      expect(has(f, -11.885, v + 4.115, 11.885, v + 4.115)).toBe(true);
      expect(has(f, -6.4, v, 6.4, v)).toBe(true);
      expect(has(f, 0, v - 6.385, 0, v + 6.385)).toBe(true);
    }
  });

  test('a basketball court: the three-point line runs on from its corners round the basket', () => {
    const f = field({ sport: 'basketball', length: 30, width: 17 });
    expect(has(f, -14, -7.5, 14, -7.5)).toBe(true);
    expect(has(f, 14, -2.45, 8.2, -2.45)).toBe(true);
    const basket = 14 - 1.575;
    const arc = segs(f).filter((s) => Math.abs(Math.hypot(s[0]! - basket, s[1]!) - 6.75) < 1e-6);
    expect(arc.length).toBeGreaterThan(4);
    // The corner straight ends where the arc starts, 6.6 m off the middle.
    const meet = basket - Math.sqrt(6.75 ** 2 - 6.6 ** 2);
    expect(has(f, 14, 6.6, meet, 6.6)).toBe(true);
    // A smaller court scales down; its lines stay inside it.
    const small = fieldLines(field({ sport: 'basketball', length: 23, width: 12 }));
    expect(Math.max(...small.filter((_, i) => i % 2 === 0))).toBeLessThanOrEqual(10.5 + 1e-9);
  });

  test("a running track's lane lines are stadiums a lane apart round the infield", () => {
    const f = field({ sport: 'track', length: 158, width: 73, count: 6 });
    const straight = 79 - 36.5;
    const lanes = new Set<number>();
    for (const s of segs(f)) {
      for (const [x, z] of [
        [s[0]!, s[1]!],
        [s[2]!, s[3]!],
      ] as const) {
        const off =
          Math.abs(x) <= straight + 1e-9 ? Math.abs(z) : Math.hypot(Math.abs(x) - straight, z);
        lanes.add(Math.round(((off - 36.5) / LANE) * 1000) / 1000);
      }
    }
    expect([...lanes].toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test('drawn as fine paint lines on the pitches, running on past their ends', () => {
    const mesh = new MeshBuilder();
    addFieldLines(mesh, [field({ sport: 'tennis', length: 34, width: 17 })]);
    const g = unindexed(mesh.build({ facade: true }));
    const [p, code] = [g.getAttribute('position'), g.getAttribute('facade')];
    expect(p.count).toBe(10 * 6);
    for (let i = 0; i < p.count; i++) {
      expect(p.getY(i)).toBeCloseTo(0.07);
      expect(readPaint(code.getX(i)).kind).toBe(PAINT_KIND.line);
    }
    const xs = Array.from({ length: p.count }, (_, i) => p.getX(i));
    expect(Math.max(...xs)).toBeCloseTo(11.885 + PAINT_HALF.line, 4);
    const none = new MeshBuilder();
    addFieldLines(none, []);
    expect(none.indices).toBe(0);
  });
});
