import { describe, expect, test } from 'bun:test';

import { LineBuilder, MeshBuilder, unindexed } from './mesh-builder.ts';
import { FLAT_GRID, landform } from '../data/terrain.ts';
import { deckStrip } from '../data/structures.ts';
import {
  addDeckFrame,
  addDeckPaint,
  addDeckSurface,
  addParapet,
  addPortals,
  addRampWalls,
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

  test('a ramp is walled while it stands clear of the ground', () => {
    const ramp = {
      line: Float32Array.of(0, 0, 20, 0, 40, 0),
      rise: Float32Array.of(4, 2, 0),
      half: 4,
      rail: false,
    };
    const mesh = new MeshBuilder();
    const lines = new LineBuilder();
    addRampWalls(mesh, lines, ramp, landform(FLAT_GRID, [ramp], []));
    expect(mesh.indices).toBeGreaterThan(0);
    const cutting = { ...ramp, rise: Float32Array.of(-4, -2, 0) };
    const low = new MeshBuilder();
    addRampWalls(low, new LineBuilder(), cutting, landform(FLAT_GRID, [cutting], []));
    expect(low.indices).toBeGreaterThan(0);
  });

  test("a ramp's wall stops at another's roadway: it would stand in the road", () => {
    const ramp = {
      line: Float32Array.of(0, 0, 40, 0),
      rise: Float32Array.of(3, 3),
      half: 3,
      rail: false,
    };
    const beside = { ...ramp, line: Float32Array.of(0, 4, 40, 4) };
    const far = { ...ramp, line: Float32Array.of(0, 400, 40, 400) };
    const carved = landform(FLAT_GRID, [ramp, beside], []);
    const count = (others: (typeof ramp)[]) => {
      const mesh = new MeshBuilder();
      addRampWalls(mesh, new LineBuilder(), ramp, carved, others);
      return mesh.indices;
    };
    // The tip's two faces stand whatever the walls do.
    const tip = 12;
    const alone = count([ramp, far]);
    expect(alone).toBe(count([]));
    // Near enough to look at the walls length by length, too far to cover either: both stand whole.
    expect(count([{ ...ramp, line: Float32Array.of(0, 5.8, 40, 5.8) }])).toBe(alone);
    // Over the one on the side it lies: that side goes.
    expect(count([ramp, beside])).toBe(tip + (alone - tip) / 2);
    // At another height it's a step, and the wall stays.
    expect(count([ramp, { ...beside, rise: Float32Array.of(-3, -3) }])).toBe(alone);
    // Partly along it: the wall stops where it starts, one length either side.
    expect(count([{ ...beside, line: Float32Array.of(10, 4, 20, 4) }])).toBe(
      tip + ((alone - tip) * 3) / 2,
    );
  });

  test("a ramp's high end is faced both ways: seen from under its deck it was a hole", () => {
    const up = {
      line: Float32Array.of(0, 0, 40, 0),
      rise: Float32Array.of(3, 0),
      half: 3,
      rail: false,
    };
    const down = { ...up, rise: Float32Array.of(-3, 0) };
    const carved = landform(FLAT_GRID, [up, down], []);
    const faces = (ramp: typeof up) => {
      const mesh = new MeshBuilder();
      addRampWalls(mesh, new LineBuilder(), ramp, carved);
      return mesh.indices;
    };
    const flat = { ...up, rise: Float32Array.of(0, 0) };
    expect(faces(flat)).toBe(0);
    // A cutting has its floor at the tip, so no face; the rising one has its two more.
    expect(faces(up)).toBeGreaterThan(0);
    expect(faces(down)).toBeGreaterThan(0);
  });

  test('even a step too low to wall is faced, or the ground under the road shows in it', () => {
    const low = {
      line: Float32Array.of(0, 0, 40, 0),
      rise: Float32Array.of(0.1, 0.1),
      half: 3,
      rail: false,
    };
    const mesh = new MeshBuilder();
    addRampWalls(mesh, new LineBuilder(), low, landform(FLAT_GRID, [low], []));
    expect(mesh.indices).toBeGreaterThan(12);
  });

  test("a cutting's wall reaches past the road layers, its kerb only once it is deep", () => {
    const cut = {
      line: Float32Array.of(0, 0, 40, 0),
      rise: Float32Array.of(-0.5, -0.5),
      half: 3,
      rail: false,
    };
    const carved = landform(FLAT_GRID, [cut], []);
    const [mesh, lines] = [new MeshBuilder(), new LineBuilder()];
    addRampWalls(mesh, lines, cut, carved);
    const { box } = measure(mesh);
    expect(box.max.y).toBeCloseTo(0.156, 3);
    expect(lines.segments).toBe(0);
    const deep = { ...cut, rise: Float32Array.of(-4, -4) };
    const inked = new LineBuilder();
    addRampWalls(new MeshBuilder(), inked, deep, landform(FLAT_GRID, [deep], []));
    expect(inked.segments).toBeGreaterThan(0);
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
