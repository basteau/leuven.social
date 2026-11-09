import { describe, expect, test } from 'bun:test';

import type { City } from '../data/city.ts';
import { pointInRing } from '../data/geometry.ts';
import { CHARACTER_SCALE } from './character.ts';
import { LineBuilder, MeshBuilder, unindexed } from './mesh-builder.ts';
import { PARASOLS } from './palette.ts';
import { PARASOL_RIM, addParasol, terraceParasols } from './terraces.ts';
import { FLAT_GRID } from '../data/terrain.ts';

/** A 100 × 40 m square centred on the origin. */
const SQUARE = new Float32Array([-50, -20, 50, -20, 50, 20, -50, 20]);

const city = (over: Partial<City> = {}): City => ({
  area: [{ minX: -100, minZ: -100, maxX: 100, maxZ: 100 }],
  bounds: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 },
  buildings: [],
  roads: [],
  carriageways: [],
  markings: [],
  plazas: [SQUARE],
  green: [],
  water: [],
  woods: [],
  flowerbeds: [],
  islands: [],
  hedges: [],
  treeKinds: new Uint8Array(0),
  pitches: [],
  pitchSurfaces: [],
  fields: [],
  parking: [],
  paths: [],
  rails: [],
  platforms: [],
  railLand: [],
  canopies: [],
  trees: new Float32Array(),
  treeHeights: new Float32Array(),
  props: [],
  tanks: [],
  bridges: [],
  parapets: [],
  streetNames: ['Grote Markt', 'Oude Markt'],
  streets: [],
  plazaNames: [1],
  terrain: FLAT_GRID,
  fronts: [],
  ...over,
});

describe('terraceParasols', () => {
  test('lines the long sides of Oude Markt with parasols, all inside the square', () => {
    const parasols = terraceParasols(city());
    expect(parasols.length).toBeGreaterThan(20);
    for (const p of parasols) {
      expect(pointInRing(SQUARE, p.x, p.z)).toBe(true);
      expect(Math.abs(p.z)).toBeGreaterThan(10); // two rows deep: the middle stays open
      expect(p.color).not.toBe(p.trim);
      expect(p.canopy === undefined || p.canopy > 0).toBe(true);
    }
  });

  test('leaves a gap after each café, so a row reads as cafés side by side', () => {
    const row = terraceParasols(city())
      .filter((p) => Math.abs(p.z - 16) < 0.01)
      .map((p) => p.x)
      .toSorted((a, b) => a - b);
    const steps = row.slice(1).map((x, i) => Math.round(x - row[i]!));
    expect(steps.slice(0, 6)).toEqual([5, 5, 9, 5, 5, 9]);
  });

  test('leaves room around trees', () => {
    const all = terraceParasols(city());
    const tree = all[3]!;
    const fewer = terraceParasols(city({ trees: new Float32Array([tree.x, tree.z]) }));
    expect(fewer.length).toBeLessThan(all.length);
    for (const p of fewer) expect(Math.hypot(p.x - tree.x, p.z - tree.z)).toBeGreaterThan(2);
  });

  test('only squares named for terraces get them', () => {
    expect(terraceParasols(city({ plazaNames: [0] }))).toEqual([]);
    expect(terraceParasols(city({ plazaNames: [-1] }))).toEqual([]);
  });
});

test('a parasol is a canopy facing up and out with an underside and a valance, on a pole and a foot', () => {
  const mesh = new MeshBuilder();
  const lines = new LineBuilder();
  addParasol(mesh, lines, { x: 0, z: 0, ux: 1, uz: 0, color: PARASOLS[0] });
  const g = unindexed(mesh.build());
  expect(g.getAttribute('position').count).toBe(34 * 3);
  const normals = g.getAttribute('normal');
  // The canopy's top faces up, its underside down.
  for (let i = 0; i < 12; i++) expect(normals.getY(i)).toBeGreaterThan(0);
  for (let i = 12; i < 24; i++) expect(normals.getY(i)).toBeLessThan(0);
  // The pole and foot reach the ground.
  g.computeBoundingBox();
  expect(g.boundingBox!.min.y).toBe(0);
  // The canopy's rim clears a walker's head; the apex and the pole top stay just above it.
  const heights = new Set(Array.from({ length: 24 }, (_, i) => g.getAttribute('position').getY(i)));
  expect([...heights].toSorted()).toEqual([PARASOL_RIM, 3]);
  // The figure's hair tops out at 1.85 model metres.
  expect(PARASOL_RIM).toBeGreaterThan(1.85 * CHARACTER_SCALE + 0.05);
  // The rim, and the valance's hem under it.
  expect(unindexed(lines.build()).getAttribute('position').count / 2).toBe(8);
});
