import { describe, expect, test } from 'bun:test';
import type { BufferGeometry } from 'three';

import { LANCETS, addLandmark } from './landmarks.ts';
import type { LandmarkModel, Part } from './landmarks.ts';
import { LineBuilder, MeshBuilder, unindexed } from './mesh-builder.ts';

/** A 40 × 20 m footprint centred on the origin, long side along x. */
const RING = new Float32Array([-20, -10, 20, -10, 20, 10, -20, 10]);

const model = (parts: Part[], over: Partial<LandmarkModel> = {}): LandmarkModel => ({
  base: 10,
  wall: 0xaaaaaa,
  roof: 0x333333,
  windows: false,
  parts,
  ...over,
});

function build(m: LandmarkModel): { surfaces: BufferGeometry; outlines: BufferGeometry } {
  const mesh = new MeshBuilder();
  const lines = new LineBuilder();
  addLandmark(mesh, lines, RING, m);
  return { surfaces: unindexed(mesh.build({ facade: true })), outlines: unindexed(lines.build()) };
}

/** Every triangle's stored normal must agree with its winding (front faces point outward). */
function facesOutward(g: BufferGeometry): boolean {
  const p = g.getAttribute('position').array;
  const normal = g.getAttribute('normal');
  const n = Array.from({ length: normal.count * 3 }, (_, i) =>
    normal.getComponent(Math.floor(i / 3), i % 3),
  );
  for (let i = 0; i < p.length; i += 9) {
    const [ux, uy, uz] = [p[i + 3]! - p[i]!, p[i + 4]! - p[i + 1]!, p[i + 5]! - p[i + 2]!];
    const [vx, vy, vz] = [p[i + 6]! - p[i]!, p[i + 7]! - p[i + 1]!, p[i + 8]! - p[i + 2]!];
    const cross = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    if (cross[0]! * n[i]! + cross[1]! * n[i + 1]! + cross[2]! * n[i + 2]! <= 0) return false;
  }
  return true;
}

const box = (g: BufferGeometry) => {
  g.computeBoundingBox();
  return g.boundingBox!;
};

/** Footprint of a flat 16 × 4 m hall: [x span, z span]. */
function hallSpan(across: boolean): [number, number] {
  const { surfaces } = build(
    model([{ type: 'hall', u: 0, v: 0, length: 8, width: 2, eave: 5, across }]),
  );
  const b = box(surfaces);
  return [b.max.x - b.min.x, b.max.z - b.min.z];
}

describe('halls', () => {
  test('a gabled hall: four walls, two slopes, two gable ends, peaking at the ridge', () => {
    const { surfaces, outlines } = build(
      model([{ type: 'hall', u: 0, v: 0, length: 10, width: 4, eave: 12, ridge: 18 }]),
    );
    expect(surfaces.getAttribute('position').count).toBe((4 * 2 + 2 * 2 + 2) * 3);
    expect(facesOutward(surfaces)).toBe(true);
    expect(box(surfaces).max.y).toBeCloseTo(18);
    // Eaves and corners, four rakes, one ridge.
    expect(outlines.getAttribute('position').count / 2).toBe(8 + 4 + 1);
  });

  test('`across` turns the ridge from the long side to the short side', () => {
    expect(hallSpan(false)).toEqual([16, 4]);
    expect(hallSpan(true)).toEqual([4, 16]);
  });

  test('hips slope the roof down to an end instead of a gable wall', () => {
    const hall: Part = {
      type: 'hall',
      u: 0,
      v: 0,
      length: 10,
      width: 4,
      eave: 12,
      ridge: 18,
      hips: [4, 0],
    };
    const g = build(model([hall], { roof: 0x010203 })).surfaces;
    const colors = g.getAttribute('color');
    const roofTriangles = Array.from({ length: colors.count / 3 }, (_, t) =>
      colors.getX(t * 3),
    ).filter((r) => r < 0.01).length;
    expect(roofTriangles).toBe(2 * 2 + 1);
    expect(facesOutward(g)).toBe(true);
  });

  test('flat halls get a flat top, and windows only where the model allows them', () => {
    const hall: Part = { type: 'hall', u: 5, v: 0, length: 3, width: 3, eave: 9, windows: true };
    const facade = (windows: LandmarkModel['windows']) =>
      new Set(Array.from(build(model([hall], { windows })).surfaces.getAttribute('facade').array));
    expect(facade(true)).toEqual(new Set([9, 0]));
    expect(facade(false)).toEqual(new Set([0]));
    // A church's halls all get lancets, whatever each one says.
    expect(facade('lancet')).toEqual(new Set([9 + LANCETS, 0]));
  });

  test('walls start at `from`, so a dormer can sit on a roof', () => {
    const dormer: Part = { type: 'hall', u: 0, v: 0, length: 1, width: 1, from: 20, eave: 21 };
    expect(box(build(model([dormer])).surfaces).min.y).toBe(20);
  });
});

describe('spires', () => {
  test('an octagonal turret with a spire faces outward and reaches its tip', () => {
    const spire: Part = { type: 'spire', u: 0, v: 0, radius: 2, sides: 8, top: 20, tip: 30 };
    const { surfaces, outlines } = build(model([spire]));
    expect(surfaces.getAttribute('position').count).toBe(8 * 3 * 3);
    expect(facesOutward(surfaces)).toBe(true);
    expect(box(surfaces).max.y).toBeCloseTo(30);
    // Octagons only get their top ring inked.
    expect(outlines.getAttribute('position').count / 2).toBe(8);
  });

  test('a square tower sits square to the footprint, with inked corners and hips', () => {
    const tower: Part = {
      type: 'spire',
      u: 0,
      v: 0,
      radius: Math.SQRT2 * 3,
      sides: 4,
      top: 40,
      tip: 45,
    };
    const { surfaces, outlines } = build(model([tower]));
    const b = box(surfaces);
    expect(b.max.x).toBeCloseTo(3);
    expect(b.max.z).toBeCloseTo(3);
    expect(outlines.getAttribute('position').count / 2).toBe(4 * 3);
  });

  test('a tip at or below the top makes a flat cap', () => {
    const stump: Part = {
      type: 'spire',
      u: 0,
      v: 0,
      radius: 4,
      sides: 4,
      from: 5,
      top: 30,
      tip: 30,
    };
    const g = build(model([stump])).surfaces;
    expect(box(g).max.y).toBe(30);
    expect(box(g).min.y).toBe(5);
    expect(facesOutward(g)).toBe(true);
  });
});

test('parts are placed in the footprint frame: u along its long side, v across it', () => {
  // A footprint whose long side runs along z: u is ±z, so a part at u = 15 sits at |z| = 15.
  const tall = new Float32Array([-5, -20, 5, -20, 5, 20, -5, 20]);
  const mesh = new MeshBuilder();
  addLandmark(
    mesh,
    new LineBuilder(),
    tall,
    model([{ type: 'spire', u: 15, v: 0, radius: 1, sides: 4, top: 5, tip: 5 }]),
  );
  const b = box(unindexed(mesh.build()));
  expect(Math.abs((b.max.z + b.min.z) / 2)).toBeCloseTo(15);
  expect((b.max.x + b.min.x) / 2).toBeCloseTo(0);
});
