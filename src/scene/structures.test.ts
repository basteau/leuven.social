import { describe, expect, test } from 'bun:test';

import { LineBuilder, MeshBuilder, unindexed } from './mesh-builder.ts';
import { FLAT, FLAT_GRID, landform } from '../data/terrain.ts';
import type { GroundStep } from '../data/terrain.ts';
import { deckStrip } from '../data/structures.ts';
import {
  addDeckFrame,
  addDeckPaint,
  addDeckSurface,
  addParapet,
  addPortals,
  addGroundSeam,
  addGroundStep,
  addTank,
} from './structures.ts';

const measure = (mesh: MeshBuilder) => {
  const g = unindexed(mesh.build());
  g.computeBoundingBox();
  return { triangles: g.getAttribute('position').count / 3, box: g.boundingBox!, g };
};

test('a tank is its footprint walled to its height under a lid, outlined at the top', () => {
  const [mesh, lines] = [new MeshBuilder(), new LineBuilder()];
  addTank(mesh, lines, { height: 14, ring: new Float32Array([0, 0, 6, 0, 6, 6, 0, 6]) });
  const { triangles, box, g } = measure(mesh);
  expect(triangles).toBe(4 * 2 + 2);
  expect([box.min.y, box.max.y]).toEqual([0, 14]);
  // The walls face out: the one along z = 0 faces -z.
  const normals = g.getAttribute('normal');
  expect(normals.getZ(0)).toBeLessThan(-0.9);
  expect(unindexed(lines.build()).getAttribute('position').count).toBe(4 * 2);
});

test('a parapet is a low wall under a capstone along its line, closed at both ends', () => {
  const [mesh, lines] = [new MeshBuilder(), new LineBuilder()];
  addParapet(mesh, lines, new Float32Array([0, 0, 10, 0, 10, 0, 20, 5]));
  const { triangles, box } = measure(mesh);
  // Two segments (the repeated point is skipped): two wall sides, two capstone sides and the
  // capstone's top each, plus two ends.
  expect(triangles).toBe(2 * 5 * 2 + 2 * 2);
  expect(box.max.y).toBeCloseTo(1.1);
  expect(box.min.y).toBeGreaterThan(0); // on the deck, not under the river
  expect(box.max.z - box.min.z).toBeGreaterThan(5);
  // The capstone overhangs the wall: wider than the wall's 0.4 m along the first segment.
  expect(box.min.z).toBeLessThan(-0.2);
  expect(unindexed(lines.build()).getAttribute('position').count).toBe(2 * 2 * 2);
});

const stepOf = (over: Partial<GroundStep> = {}): GroundStep => ({
  ax: 0,
  az: 0,
  bx: 40,
  bz: 0,
  high: [3, 3],
  low: [0, 0],
  ...over,
});
const faces = (step: GroundStep) => {
  const [mesh, lines] = [new MeshBuilder(), new LineBuilder()];
  addGroundStep(mesh, lines, step, FLAT);
  return { indices: mesh.indices, segments: lines.segments, box: measure(mesh).box };
};

describe('bridges and tunnels', () => {
  const deck = {
    carries: 'road' as const,
    ring: Float32Array.of(0, 0, 30, 0, 30, 10, 0, 10),
    axis: Float32Array.of(-1.5, 5, 31.5, 5),
    rise: Float32Array.of(5, 5),
    piers: Float32Array.of(10, 2),
    lanes: [
      { width: 6.4, surface: 'asphalt' as const, line: Float32Array.of(0, 5, 30, 5) },
      { width: 2, surface: 'asphalt' as const, line: Float32Array.of(0, 8, 30, 8) },
    ],
  };
  const terrain = landform(FLAT_GRID, [], [deckStrip(deck)]);

  test('a deck is held up with a surface, sides and piers', () => {
    const mesh = new MeshBuilder();
    const lines = new LineBuilder();
    mesh.drape = terrain.decks;
    addDeckSurface(mesh, deck);
    mesh.drape = null;
    addDeckFrame(mesh, lines, deck, terrain);
    const before = mesh.indices;
    expect(before).toBeGreaterThan(40);
    expect(lines.segments).toBeGreaterThan(0);
  });

  test('a step is one wall up past the road layers, with a railing over a ramp', () => {
    const { indices, segments, box } = faces(stepOf());
    expect(indices).toBe(6 * 3);
    expect(segments).toBe(1);
    expect(box.min.y).toBe(0);
    expect(box.max.y).toBeCloseTo(3 + 0.156 + 1.05, 3);
  });

  test("a cutting's high side is the street: a kerb, not a railing", () => {
    const { box } = faces(stepOf({ high: [0, 0], low: [-4, -4] }));
    expect(box.min.y).toBe(-4);
    expect(box.max.y).toBeCloseTo(0.156 + 0.5, 3);
  });

  test('a low step has its one face and no railing or ink', () => {
    const { indices, segments, box } = faces(stepOf({ high: [0.3, 0.3] }));
    expect(indices).toBe(6);
    expect(segments).toBe(0);
    expect(box.max.y).toBeCloseTo(0.3 + 0.156, 3);
  });

  test('under a deck a step has no railing to come through it', () => {
    const [mesh, lines] = [new MeshBuilder(), new LineBuilder()];
    addGroundStep(mesh, lines, stepOf(), FLAT, false);
    expect(measure(mesh).box.max.y).toBeCloseTo(3 + 0.156, 3);
  });

  test("a seam of a few centimetres is the road's own: its colour, lit as level ground", () => {
    const mesh = new MeshBuilder();
    const asked: number[][] = [];
    const seam = stepOf({ bx: 4, high: [0.1, 0.2] });
    addGroundSeam(mesh, seam, FLAT, (x, z) => {
      asked.push([x, z]);
      return x < 2 ? { color: 0x102030, y: 0.2 } : null;
    });
    // A length of 1.5 m at a time, each asking what lies over it: to the left of a to b.
    expect(mesh.indices).toBe(3 * 6);
    expect(asked).toHaveLength(3);
    expect(asked.every(([, z]) => z! > 0)).toBe(true);
    const g = unindexed(mesh.build());
    const [normal, colour] = [g.getAttribute('normal'), g.getAttribute('color')];
    for (let i = 0; i < normal.count; i++) expect(normal.getY(i)).toBeGreaterThan(0.99);
    expect(colour.getX(0)).not.toBe(colour.getX(colour.count - 1));
    // Up to the top of the layer over it where there is one, of the carriageway where not.
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y).toBeCloseTo(0.2 + 0.156, 3);
    expect(mesh.level).toBe(false);
    addGroundSeam(mesh, stepOf({ bx: 0 }), FLAT, () => null);
    expect(mesh.indices).toBe(18);
  });

  test('a step of no length is nothing', () => {
    const [mesh, lines] = [new MeshBuilder(), new LineBuilder()];
    addGroundStep(mesh, lines, stepOf({ bx: 0 }), FLAT);
    expect(mesh.indices).toBe(0);
  });

  test("a deck's road is the colour of the road it comes from, and dashed down the middle", () => {
    const road = {
      kind: 'main' as const,
      surface: 'asphalt' as const,
      ring: Float32Array.of(20, -5, 40, -5, 40, 5, 20, 5),
    };
    const span = {
      carries: 'road' as const,
      ring: Float32Array.of(0, -4, 20, -4, 20, 4, 0, 4),
      axis: Float32Array.of(-2, 0, 22, 0),
      rise: Float32Array.of(5, 5),
      piers: new Float32Array(0),
      lanes: [{ width: 6.4, surface: 'asphalt' as const, line: Float32Array.of(0, 0, 20, 0) }],
    };
    const colours = (carriageways: (typeof road)[]) => {
      const mesh = new MeshBuilder();
      addDeckSurface(mesh, span, carriageways as never);
      const colour = unindexed(mesh.build()).getAttribute('color');
      return colour.getX(colour.count - 1);
    };
    expect(colours([road])).not.toBe(colours([]));
    expect(colours([{ ...road, kind: 'cycleway' as never }])).toBe(colours([]));
    const paint = new MeshBuilder();
    addDeckPaint(paint, span);
    expect(paint.indices).toBe(3 * 6);
    const narrow = new MeshBuilder();
    addDeckPaint(narrow, { ...span, lanes: [{ ...span.lanes[0]!, width: 2 }] });
    expect(narrow.indices).toBe(0);
    addDeckPaint(narrow, {
      ...span,
      lanes: [{ ...span.lanes[0]!, line: Float32Array.of(0, 0, 0, 0, 20, 0) }],
    });
    expect(narrow.indices).toBe(3 * 6);
  });

  test('a tunnel has a portal only at a mouth that opens', () => {
    const tunnel = {
      carries: 'road' as const,
      line: Float32Array.of(0, 0, 40, 0),
      half: 3,
      depth: 5,
      mouths: [true, false] as [boolean, boolean],
    };
    const mesh = new MeshBuilder();
    addPortals(mesh, new LineBuilder(), tunnel, landform(FLAT_GRID, [], []));
    const one = mesh.indices;
    expect(one).toBeGreaterThan(0);
    const both = new MeshBuilder();
    addPortals(
      both,
      new LineBuilder(),
      { ...tunnel, mouths: [true, true] },
      landform(FLAT_GRID, [], []),
    );
    expect(both.indices).toBe(one * 2);
  });
});
