import { describe, expect, test } from 'bun:test';

import type { City } from '../data/city.ts';
import { pointInRing } from '../data/geometry.ts';
import { LineBuilder, MeshBuilder } from './mesh-builder.ts';
import { PARASOLS } from './palette.ts';
import { addParasol, terraceParasols } from './terraces.ts';

/** A 100 × 40 m square centred on the origin. */
const SQUARE = new Float32Array([-50, -20, 50, -20, 50, 20, -50, 20]);

const city = (over: Partial<City> = {}): City => ({
  area: [{ minX: -100, minZ: -100, maxX: 100, maxZ: 100 }],
  bounds: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 },
  labels: [{ name: 'Oude Markt', x: 0, z: 0, minZoom: 0 }],
  buildings: [],
  roads: [],
  carriageways: [],
  markings: [],
  plazas: [SQUARE],
  green: [],
  water: [],
  paths: [],
  trees: new Float32Array(),
  treeHeights: new Float32Array(),
  props: [],
  tanks: [],
  parapets: [],
  ...over,
});

describe('terraceParasols', () => {
  test('lines the long sides of Oude Markt with parasols, all inside the square', () => {
    const parasols = terraceParasols(city());
    expect(parasols.length).toBeGreaterThan(20);
    for (const p of parasols) {
      expect(pointInRing(SQUARE, p.x, p.z)).toBe(true);
      expect(Math.abs(p.z)).toBeGreaterThan(5); // the middle of the square stays open
      expect(PARASOLS).toContain(p.color as (typeof PARASOLS)[number]);
    }
  });

  test('leaves room around trees', () => {
    const all = terraceParasols(city());
    const tree = all[3]!;
    const fewer = terraceParasols(city({ trees: new Float32Array([tree.x, tree.z]) }));
    expect(fewer.length).toBeLessThan(all.length);
    for (const p of fewer) expect(Math.hypot(p.x - tree.x, p.z - tree.z)).toBeGreaterThan(2);
  });

  test('only squares named for terraces get them', () => {
    expect(
      terraceParasols(city({ labels: [{ name: 'Grote Markt', x: 0, z: 0, minZoom: 0 }] })),
    ).toEqual([]);
    expect(
      terraceParasols(city({ labels: [{ name: 'Oude Markt', x: 90, z: 0, minZoom: 0 }] })),
    ).toEqual([]);
  });
});

test('a parasol is a four-sided canopy facing up and out, with an inked rim', () => {
  const mesh = new MeshBuilder();
  const lines = new LineBuilder();
  addParasol(mesh, lines, { x: 0, z: 0, ux: 1, uz: 0, color: PARASOLS[0] });
  const g = mesh.build();
  expect(g.getAttribute('position').count).toBe(4 * 3);
  const normals = g.getAttribute('normal');
  for (let i = 0; i < normals.count; i++) expect(normals.getY(i)).toBeGreaterThan(0);
  expect(lines.build().getAttribute('position').count / 2).toBe(4);
});
