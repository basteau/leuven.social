import { describe, expect, test } from 'bun:test';

import type { Building } from '../data/city.ts';
import { buildingsGeometry, planRoof } from './buildings.ts';
import { LANDMARK_MODELS } from './landmark-models.ts';
import { pick } from './palette.ts';

const box = (w: number, d: number): Float32Array => new Float32Array([0, 0, w, 0, w, d, 0, d]);

const building = (over: Partial<Building>): Building => ({
  id: 1,
  tier: 'core',
  kind: 'house',
  roof: 'auto',
  height: 10,
  ring: box(6, 12),
  ...over,
});

/** Every triangle's stored normal must agree with its winding (front faces point outward). */
function windingAgreesWithNormals(b: Building): boolean {
  const g = buildingsGeometry([b]).surfaces;
  const p = g.getAttribute('position').array;
  const n = g.getAttribute('normal').array;
  for (let i = 0; i < p.length; i += 9) {
    const [ux, uy, uz] = [p[i + 3]! - p[i]!, p[i + 4]! - p[i + 1]!, p[i + 5]! - p[i + 2]!];
    const [vx, vy, vz] = [p[i + 6]! - p[i]!, p[i + 7]! - p[i + 1]!, p[i + 8]! - p[i + 2]!];
    const cross = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    if (cross[0]! * n[i]! + cross[1]! * n[i + 1]! + cross[2]! * n[i + 2]! <= 0) return false;
  }
  return true;
}

describe('planRoof', () => {
  test('narrow row houses get a gable whose rise comes out of the wall height', () => {
    const plan = planRoof(building({}));
    expect(plan.type).toBe('gable');
    if (plan.type === 'gable') {
      expect(plan.ridge).toBe(10);
      expect(plan.eave).toBeCloseTo(10 - 3 * 0.9);
    }
  });

  test('towers, civic buildings, odd shapes and flat-tagged roofs stay flat', () => {
    expect(planRoof(building({ height: 40 })).type).toBe('flat');
    expect(planRoof(building({ kind: 'civic' })).type).toBe('flat');
    expect(planRoof(building({ roof: 'flat' })).type).toBe('flat');
    const ell = new Float32Array([0, 0, 10, 0, 10, 2, 2, 2, 2, 10, 0, 10]);
    expect(planRoof(building({ ring: ell })).type).toBe('flat');
  });
});

describe('buildingsGeometry', () => {
  test('a flat box is 4 walls and a 2-triangle roof, all facing outward', () => {
    const b = building({ roof: 'flat' });
    expect(buildingsGeometry([b]).surfaces.getAttribute('position').count).toBe((4 * 2 + 2) * 3);
    expect(windingAgreesWithNormals(b)).toBe(true);
  });

  test('a gabled house faces outward too and peaks at its height', () => {
    const b = building({});
    expect(windingAgreesWithNormals(b)).toBe(true);
    const g = buildingsGeometry([b]).surfaces;
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y).toBeCloseTo(10);
  });

  test('walls carry their top height for the window shader; roofs carry 0', () => {
    const plan = planRoof(building({}));
    const facade = buildingsGeometry([building({})]).surfaces.getAttribute('facade');
    const values = new Set(Array.from({ length: facade.count }, (_, i) => facade.getX(i)));
    expect(values).toEqual(new Set([Math.fround(plan.eave), 0]));
  });

  test('churches get no window grid', () => {
    const facade = buildingsGeometry([
      building({ kind: 'church', roof: 'flat' }),
    ]).surfaces.getAttribute('facade');
    expect(
      Array.from({ length: facade.count }, (_, i) => facade.getX(i)).every((v) => v === 0),
    ).toBe(true);
  });
});

describe('outlines', () => {
  test('a flat box has its base, top and four corners outlined', () => {
    const { outlines } = buildingsGeometry([building({ roof: 'flat' })]);
    expect(outlines.getAttribute('position').count / 2).toBe(4 + 4 + 4);
  });

  test('a gabled house adds eaves, rakes and the ridge', () => {
    const { outlines } = buildingsGeometry([building({})]);
    expect(outlines.getAttribute('position').count / 2).toBe(12 + 2 * 3 + 1);
  });

  test('gentle bends in a curved wall are not outlined as corners', () => {
    const arc = Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2;
      return [Math.cos(a) * 10, Math.sin(a) * 10];
    }).flat();
    const { outlines } = buildingsGeometry([
      building({ roof: 'flat', ring: new Float32Array(arc) }),
    ]);
    expect(outlines.getAttribute('position').count / 2).toBe(16 + 16);
  });
});

/** A house wide and tall enough for steps. */
const wide = (over: Partial<Building>) => building({ ring: box(8, 14), height: 14, ...over });
/** How many of 300 such houses in a tier get stepped gables. */
const steppedCount = (tier: Building['tier']) =>
  Array.from({ length: 300 }, (_, id) => planRoof(wide({ id, tier }))).filter(
    (p) => p.type === 'gable' && p.stepped,
  ).length;

describe('stepped gables', () => {
  const steppedId = Array.from({ length: 50 }, (_, i) => i).find((id) => {
    const plan = planRoof(wide({ id, tier: 'hero' }));
    return plan.type === 'gable' && plan.stepped;
  })!;

  test('hero squares get more of them than ordinary streets, the fringe none', () => {
    expect(steppedCount('hero')).toBeGreaterThan(steppedCount('core'));
    expect(steppedCount('core')).toBeGreaterThan(0);
    expect(steppedCount('fringe')).toBe(0);
  });

  test('narrow gables stay plain: the steps would be smaller than a pixel', () => {
    const plan = planRoof(building({ id: steppedId, tier: 'hero', ring: box(4, 12) }));
    expect(plan.type === 'gable' && plan.stepped).toBe(false);
  });

  test('steps climb above the ridge, face outward and replace the gable triangles', () => {
    const b = wide({ id: steppedId, tier: 'hero' });
    expect(windingAgreesWithNormals(b)).toBe(true);
    const { surfaces, outlines } = buildingsGeometry([b]);
    surfaces.computeBoundingBox();
    expect(surfaces.boundingBox!.max.y).toBeGreaterThan(14);
    // 3 steps a side, 4 quads each, on both sides of both ends; plus walls and slopes.
    expect(surfaces.getAttribute('position').count).toBe((4 * 2 + 2 * 2 + 2 * 2 * 3 * 4 * 2) * 3);
    // Base, eave tops, corners, two eaves, ridge, then a riser and a tread per step.
    expect(outlines.getAttribute('position').count / 2).toBe(12 + 2 + 1 + 2 * 2 * 3 * 2);
  });
});

describe('landmarks', () => {
  const [id, model] = [...LANDMARK_MODELS][0]!;
  const ring = new Float32Array([-30, -15, 30, -15, 30, 15, -30, 15]);

  test('a landmark extrudes its footprint to its base and builds its parts above', () => {
    const b = building({ id, tier: 'hero', kind: 'civic', height: 30, ring });
    const g = buildingsGeometry([b]).surfaces;
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y).toBeGreaterThan(model.base + 10);
    const facade = g.getAttribute('facade');
    expect(Array.from({ length: facade.count }, (_, i) => facade.getX(i))).toContain(model.base);
  });
});

test('café parasols ride along in the buildings geometry', () => {
  const parasol = { x: 0, z: 0, ux: 1, uz: 0, color: 0xffffff };
  const without = buildingsGeometry([]).surfaces.getAttribute('position').count;
  expect(buildingsGeometry([], [parasol]).surfaces.getAttribute('position').count).toBe(
    without + 12,
  );
});

test('pick is deterministic and stays in range', () => {
  const list = [1, 2, 3];
  expect(pick(list, 42)).toBe(pick(list, 42));
  for (let i = 0; i < 100; i++) expect(list).toContain(pick(list, i));
});
