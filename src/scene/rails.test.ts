import { expect, test } from 'bun:test';

import type { Rail } from '../data/city.ts';
import { LineBuilder, MeshBuilder, unindexed } from './mesh-builder.ts';
import { ANGLES, PAINT_KIND, SURFACE } from './paint.ts';
import {
  GAUGE,
  PLATFORM_HEIGHT,
  SLEEPER_CODE,
  addMasts,
  addRailParapet,
  addPlatform,
  addRailLines,
  addCanopyBay,
  addTracks,
  canopyBays,
  planRailway,
} from './rails.ts';

const track = (z: number, overrides: Partial<Rail> = {}, length = 200): Rail => ({
  kind: 'main',
  bridge: false,
  electrified: true,
  line: new Float32Array([0, z, length, z]),
  ...overrides,
});

test('masts stand every 60 m beside an electrified running line, arms over the track', () => {
  const { masts, parapets } = planRailway([track(0)]);
  expect(masts.map((m) => m.tx)).toEqual([30, 90, 150]);
  for (const m of masts) {
    expect(m.tz).toBe(0);
    expect(Math.abs(m.z)).toBeCloseTo(3.4);
  }
  expect(parapets).toEqual([]);
});

test('in a bundle of tracks only the outer ones get masts, on their outer side', () => {
  const { masts } = planRailway([track(0), track(4.5), track(9)]);
  expect(masts.filter((m) => m.tz === 4.5)).toEqual([]);
  expect(masts.filter((m) => m.tz === 0).every((m) => m.z < 0)).toBe(true);
  expect(masts.filter((m) => m.tz === 9).every((m) => m.z > 9)).toBe(true);
  expect(masts).toHaveLength(6);
});

test('yards, unelectrified lines and the same track mapped twice add no extra masts', () => {
  expect(planRailway([track(0, { kind: 'yard' })]).masts).toEqual([]);
  expect(planRailway([track(0, { electrified: false })]).masts).toEqual([]);
  expect(planRailway([track(0), track(0)]).masts).toHaveLength(3);
});

test('a track running on along several ways keeps its rhythm, and skips zero-length bits', () => {
  const pieces = [
    track(0, { line: new Float32Array([0, 0, 0, 0, 100, 0]) }),
    track(0, { line: new Float32Array([100, 0, 200, 0]) }),
  ];
  expect(planRailway(pieces).masts.map((m) => m.tx)).toEqual([30, 90, 130, 190]);
});

test("a cell's piece of a track goes on from where the last one left off", () => {
  // Cut at x = 100: the second piece starts 100 m along, so its masts keep the 60 m rhythm.
  const second = { ...track(0, { line: new Float32Array([100, 0, 200, 0]) }), from: 100 };
  expect(planRailway([second]).masts.map((m) => m.tx)).toEqual([150]);
  const mesh = new MeshBuilder();
  addTracks(mesh, [second]);
  const facade = unindexed(mesh.build({ facade: true })).getAttribute('facade');
  const values = Array.from({ length: facade.count }, (_, i) => facade.getX(i)).filter(Boolean);
  expect([Math.max(...values), Math.min(...values)]).toEqual([
    -SLEEPER_CODE - 100,
    -SLEEPER_CODE - 200,
  ]);
});

test('bridge parapets line only the sides no other bridge track runs beside', () => {
  const single = planRailway([track(0, { bridge: true, electrified: false }, 40)]).parapets;
  expect(single.map((p) => p.nz).toSorted()).toEqual([-1, 1]);
  expect(single.map((p) => Math.abs(p.az))).toEqual([2.4, 2.4]);
  const pair = planRailway([
    track(0, { bridge: true, electrified: false }, 40),
    track(4.5, { bridge: true, electrified: false }, 40),
  ]).parapets;
  expect(pair.map((p) => p.az).toSorted((a, b) => a - b)).toEqual([-2.4, 6.9]);
});

test('a track is a ballast bed and a sleeper band carrying the distance along it', () => {
  const mesh = new MeshBuilder();
  addTracks(mesh, [track(0, { line: new Float32Array([0, 0, 10, 0, 10, 0, 10, 20]) })]);
  const g = unindexed(mesh.build({ facade: true }));
  const position = g.getAttribute('position');
  // Two segments (the zero-length one is skipped), two quads each.
  expect(position.count).toBe(2 * 2 * 2 * 3);
  const facade = g.getAttribute('facade');
  const values = Array.from({ length: facade.count }, (_, i) => facade.getX(i));
  expect(values.filter((v) => v === 0)).toHaveLength(12);
  expect(Math.max(...values.filter((v) => v !== 0))).toBe(-SLEEPER_CODE);
  expect(Math.min(...values)).toBe(-SLEEPER_CODE - 30);
  for (let i = 0; i < position.count; i++) expect(g.getAttribute('normal').getY(i)).toBe(1);
});

test('rails and masts are ink lines: two per track segment, four per mast and two wires between', () => {
  const lines = new LineBuilder();
  addRailLines(lines, [track(0), track(5, { line: new Float32Array([0, 5, 0, 5]) })]);
  expect(lines.segments).toBe(2);
  const g = unindexed(lines.build());
  const position = g.getAttribute('position');
  expect(Math.abs(position.getZ(0) - position.getZ(2))).toBeCloseTo(GAUGE);
  addMasts(lines, planRailway([track(0)]).masts);
  // Four lines a mast, and two wires to the next one along.
  expect(lines.segments).toBe(2 + 3 * 4 + 2 * 2);
});

test('a parapet is a low wall with its top outlined', () => {
  const [mesh, lines] = [new MeshBuilder(), new LineBuilder()];
  addRailParapet(mesh, lines, { ax: 0, az: 2.4, bx: 10, bz: 2.4, nx: 0, nz: 1 });
  const g = unindexed(mesh.build());
  expect(g.getAttribute('position').count).toBe(3 * 2 * 3);
  expect(g.getAttribute('normal').getZ(0)).toBe(1);
  expect(lines.segments).toBe(2);
});

const far = { minX: -100, minZ: -100, maxX: 100, maxZ: 100 };

test('a platform cut at a cell border gets no wall or edge along the cut', () => {
  const [mesh, lines] = [new MeshBuilder(), new LineBuilder()];
  const cell = { minX: -100, minZ: -100, maxX: 10, maxZ: 100 };
  addPlatform(mesh, lines, new Float32Array([0, 0, 10, 0, 10, 4, 0, 4]), cell);
  expect(unindexed(mesh.build()).getAttribute('position').count).toBe((2 + 3 * 2) * 3);
  expect(lines.segments).toBe(3);
  const bottom = { minX: -100, minZ: -100, maxX: 100, maxZ: 4 };
  addPlatform(mesh, lines, new Float32Array([0, 0, 10, 0, 10, 4, 0, 4]), bottom);
  expect(lines.segments).toBe(6);
});

test('a platform is its outline raised to train-floor height, walls facing out', () => {
  const [mesh, lines] = [new MeshBuilder(), new LineBuilder()];
  addPlatform(mesh, lines, new Float32Array([0, 0, 10, 0, 10, 4, 0, 4]), far);
  const g = unindexed(mesh.build());
  expect(g.getAttribute('position').count).toBe((2 + 4 * 2) * 3);
  g.computeBoundingBox();
  expect(g.boundingBox!.max.y).toBeCloseTo(PLATFORM_HEIGHT);
  // The first wall runs along z = 0, the platform lies at z > 0: it faces -z.
  expect(g.getAttribute('normal').getZ(2 * 3)).toBe(-1);
  expect(lines.segments).toBe(4);
});

test('a platform roof is cut into bays of about 51 m along its long side', () => {
  const roof = new Float32Array([0, 0, 60, 0, 60, 204, 0, 204]);
  const bays = canopyBays(roof);
  expect(bays).toHaveLength(4);
  expect(bays.map((b) => Math.round(b.cz))).toEqual([26, 77, 128, 179]);
  for (const b of bays) {
    expect(b.halfLength).toBeCloseTo(25.5);
    expect(b.halfWidth).toBeCloseTo(30);
    expect(b.cx).toBeCloseTo(30);
  }
  expect(canopyBays(new Float32Array([0, 0, 20, 0, 20, 10, 0, 10]))).toHaveLength(1);
});

test('a bay is a vault from valley to crown, ends filled, outlined, on four posts', () => {
  const [mesh, lines] = [new MeshBuilder(), new LineBuilder()];
  addCanopyBay(mesh, lines, { cx: 0, cz: 0, ux: 0, uz: 1, halfLength: 25, halfWidth: 30 });
  const g = unindexed(mesh.build());
  // Four vault strips of two triangles, and four triangles at each end.
  expect(g.getAttribute('position').count).toBe((4 * 2 + 2 * 4) * 3);
  g.computeBoundingBox();
  expect(g.boundingBox!.min.y).toBeCloseTo(9.5);
  expect(g.boundingBox!.max.y).toBeCloseTo(16);
  // Two edge profiles of four segments, two valleys, four posts.
  expect(lines.segments).toBe(8 + 2 + 4);
});

test('sleeper codes lie past every road surface and paint code', () => {
  expect(SLEEPER_CODE).toBeGreaterThan((PAINT_KIND.patch + 1) * ANGLES * 2);
  expect(SLEEPER_CODE).toBeGreaterThan(SURFACE.paving);
});
