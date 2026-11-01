import { expect, test } from 'bun:test';

import { LineBuilder, MeshBuilder, unindexed } from './mesh-builder.ts';
import { addParapet, addTank } from './structures.ts';

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

test('a parapet is a low wall along its line, capped at both ends', () => {
  const [mesh, lines] = [new MeshBuilder(), new LineBuilder()];
  addParapet(mesh, lines, new Float32Array([0, 0, 10, 0, 10, 0, 20, 5]));
  const { triangles, box } = measure(mesh);
  // Two segments (the repeated point is skipped): two sides and a top each, plus two ends.
  expect(triangles).toBe(2 * 3 * 2 + 2 * 2);
  expect(box.max.y).toBeCloseTo(1.1);
  expect(box.min.y).toBeGreaterThan(0); // on the deck, not under the river
  expect(box.max.z - box.min.z).toBeGreaterThan(5);
  expect(unindexed(lines.build()).getAttribute('position').count).toBe(2 * 2 * 2);
});
