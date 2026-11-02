import { describe, expect, test } from 'bun:test';

import { Terrain } from '../data/terrain.ts';
import { footing } from './buildings.ts';
import {
  Footings,
  PLATE_DEPTH,
  PlateBuffers,
  addPlate,
  packCells,
  plateOutline,
  plateWidth,
} from './plate-mesh.ts';
import type { PlateStyle, Slice } from './plate-mesh.ts';

const slice = (u0: number, width: number): Slice => ({
  u0,
  v0: 0.5,
  u1: u0 + 0.1,
  v1: 0.75,
  width,
});
const style: PlateStyle = {
  height: 0.25,
  radius: 0.2,
  left: slice(0, 0.3),
  right: slice(0.1, 0.3),
  blank: slice(0.2, 0),
  minWidth: 1.5,
  glyphs: new Map([
    ['1', slice(0.3, 0.4)],
    ['2', slice(0.4, 0.5)],
  ]),
};
const ink: [number, number] = [0.9, 0.1];

describe('plateWidth', () => {
  test('is the caps and letters, or the least width', () => {
    expect(plateWidth('12', style)).toBeCloseTo(1.5);
    expect(plateWidth('1212', style)).toBeCloseTo(0.6 + 1.8);
    expect(plateWidth('', style)).toBe(1.5);
  });

  test('skips letters it has no slice for', () => {
    expect(plateWidth('1x2x', style)).toBeCloseTo(plateWidth('12', style));
  });
});

test('plateOutline goes round four rounded corners, counter-clockwise', () => {
  const points = plateOutline(2, 1, 0.2);
  expect(points).toHaveLength(32);
  let area = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    area += points[i]! * points[j + 1]! - points[j]! * points[i + 1]!;
  }
  // Counter-clockwise, and just under the full rectangle for the rounded corners.
  expect(area / 2).toBeGreaterThan(1.95);
  expect(area / 2).toBeLessThan(2);
  for (let i = 0; i < points.length; i += 2) {
    expect(Math.abs(points[i]!)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.abs(points[i + 1]!)).toBeLessThanOrEqual(0.5 + 1e-9);
  }
  // A radius larger than the plate is clamped to it.
  expect(Math.max(...plateOutline(1, 0.2, 5).filter((_, i) => i % 2 === 1))).toBeCloseTo(0.1);
});

describe('addPlate', () => {
  const plate = { x: 10, y: 2, z: -4, angle: Math.PI / 2, text: '12', style };

  test('builds a face that looks along the wall normal and sides that reach the wall', () => {
    const out = new PlateBuffers();
    addPlate(out, plate, ink);
    expect(out.vertices).toBeGreaterThan(40);
    expect(out.count % 3).toBe(0);
    // The face looks +z (angle a quarter turn): its normals; every vertex within the plate.
    const zs: number[] = [];
    for (let v = 0; v < out.vertices; v++) {
      const [x, y, z] = [
        out.positions[v * 3]!,
        out.positions[v * 3 + 1]!,
        out.positions[v * 3 + 2]!,
      ];
      expect(Math.abs(x - 10)).toBeLessThanOrEqual((1.5 * 0.25) / 2 + 1e-5);
      expect(Math.abs(y - 2)).toBeLessThanOrEqual(0.125 + 1e-5);
      zs.push(z);
    }
    expect(Math.max(...zs)).toBeCloseTo(-4);
    expect(Math.min(...zs)).toBeCloseTo(-4 - PLATE_DEPTH);
    expect(out.normals[2]).toBeCloseTo(1);
    // Every index points at a vertex.
    for (let i = 0; i < out.count; i++) expect(out.indices[i]!).toBeLessThan(out.vertices);
  });

  test('turns the face counter-clockwise toward the viewer in front of it', () => {
    const out = new PlateBuffers();
    addPlate(out, plate, ink);
    const p = (i: number) => [0, 1, 2].map((k) => out.positions[out.indices[i]! * 3 + k]!);
    const [a, b, c] = [p(0), p(1), p(2)];
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    // The cross product of the first triangle points out of the face (+z).
    expect(e1[0]! * e2[1]! - e1[1]! * e2[0]!).toBeGreaterThan(0);
  });

  test('maps letters onto their slices and the sides onto ink', () => {
    const out = new PlateBuffers();
    addPlate(out, plate, ink);
    const us = new Set<number>();
    for (let v = 0; v < out.vertices; v++) us.add(Math.round(out.uvs[v * 2]! * 100) / 100);
    for (const u of [0.3, 0.4, 0.5, 0.9]) expect(us).toContain(u);
  });

  test('pads a short text with blank enamel, and none a long one', () => {
    const short = new PlateBuffers();
    addPlate(short, { ...plate, text: '1' }, ink);
    const long = new PlateBuffers();
    addPlate(long, { ...plate, text: '1212' }, ink);
    // One letter and two pads against four letters: the same number of quads.
    expect(short.vertices).toBe(long.vertices - 4);
  });

  test('grows its buffers and starts over on reset', () => {
    const out = new PlateBuffers();
    for (let i = 0; i < 50; i++) addPlate(out, { ...plate, x: i }, ink);
    const one = new PlateBuffers();
    addPlate(one, plate, ink);
    expect(out.vertices).toBe(one.vertices * 50);
    expect(out.positions[(one.vertices * 49 + 1) * 3 - 3]).toBeCloseTo(49, 0);
    out.reset();
    expect([out.vertices, out.count]).toEqual([0, 0]);
    addPlate(out, plate, ink);
    expect(Array.from(out.positions.slice(0, 9))).toEqual(Array.from(one.positions.slice(0, 9)));
  });
});

describe('packCells', () => {
  test('lays cells in rows, a gutter apart, and rounds the height up', () => {
    const { at, height } = packCells(
      [
        { width: 40, height: 20 },
        { width: 40.5, height: 30 },
        { width: 40, height: 20 },
      ],
      120,
      4,
    );
    expect(at).toEqual([
      [4, 4],
      [48, 4],
      [4, 38],
    ]);
    expect(height).toBe(64);
  });

  test('a cell wider than the atlas still gets a row of its own', () => {
    expect(packCells([{ width: 500, height: 10 }], 100, 2).at).toEqual([[2, 2]]);
    expect(packCells([], 100, 2).height).toBe(4);
  });
});

describe('Footings', () => {
  // Rising 0.1 m a metre to the east.
  const slope = new Terrain({
    step: 100,
    minX: -100,
    minZ: -100,
    cols: 3,
    rows: 3,
    heights: Float32Array.of(-10, 0, 10, -10, 0, 10, -10, 0, 10),
  });
  // A house from x = 23 to 60, its lowest corner at 2.3 m (it stands at 2), and one further west.
  const footings = new Footings(
    [Float32Array.of(23, 0, 60, 0, 60, 10, 23, 10), Float32Array.of(-43, 30, -30, 30, -30, 40)],
    { footing: (ring) => footing(slope, ring), height: (x, z) => slope.height(x, z) },
  );

  test('a plate hangs from the foot of its house, wherever along the wall it is', () => {
    // On the front wall (z = 0, facing -z), at either end.
    expect(footings.at(25, -0.05, -Math.PI / 2)).toBeCloseTo(2);
    expect(footings.at(58, -0.05, -Math.PI / 2)).toBeCloseTo(2);
    // On the east wall, facing +x.
    expect(footings.at(60.05, 5, 0)).toBeCloseTo(2);
    expect(footings.at(-35, 29.95, -Math.PI / 2)).toBeCloseTo(-4.5);
  });

  test('a plate on no house hangs over the ground at its point', () => {
    expect(footings.at(80, 50, 0)).toBeCloseTo(8);
  });
});
