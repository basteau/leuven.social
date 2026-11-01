import { describe, expect, test } from 'bun:test';

import type { Building } from '../data/city.ts';
import {
  SHOP_FRONT,
  addBuilding,
  buildingsGeometry,
  cutAt,
  partyWalls,
  planRoof,
} from './buildings.ts';
import { LANDMARK_MODELS } from './landmark-models.ts';
import { LineBuilder, MeshBuilder } from './mesh-builder.ts';
import { pick } from './palette.ts';

const box = (w: number, d: number): Float32Array => new Float32Array([0, 0, w, 0, w, d, 0, d]);

const building = (over: Partial<Building>): Building => ({
  id: 1,
  tier: 'core',
  kind: 'house',
  roof: 'auto',
  height: 10,
  // No survey by default: the eave sits at the roof top, so the roof shape is guessed.
  eave: over.height ?? 10,
  roofColor: null,
  ring: box(6, 12),
  holes: [],
  ...over,
});

/** Every triangle's stored normal must agree with its winding (front faces point outward). */
function windingAgreesWithNormals(b: Building): boolean {
  const g = buildingsGeometry([b]).surfaces;
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

describe('planRoof', () => {
  test('narrow row houses get a gable whose rise comes out of the wall height', () => {
    const plan = planRoof(building({}));
    expect(plan.type).toBe('gable');
    if (plan.type === 'gable') {
      expect(plan.ridge).toBe(10);
      expect(plan.eave).toBeCloseTo(10 - 3 * 0.9);
    }
  });

  test('unsurveyed towers and civic buildings, and flat-tagged roofs, stay flat', () => {
    expect(planRoof(building({ height: 40 })).type).toBe('flat');
    expect(planRoof(building({ kind: 'civic' })).type).toBe('flat');
    expect(planRoof(building({ roof: 'flat' })).type).toBe('flat');
    expect(planRoof(building({ ring: box(3, 3) })).type).toBe('flat');
  });

  test('a surveyed roof takes its rise from the LiDAR, capped by the width', () => {
    const plan = planRoof(building({ roof: 'gabled', height: 12, eave: 9 }));
    expect(plan).toMatchObject({ type: 'gable', eave: 9, ridge: 12 });
    const steep = planRoof(building({ roof: 'gabled', height: 14, eave: 3 }));
    expect(steep.eave).toBeCloseTo(14 - 3 * 1.5);
  });

  test('odd shapes get a hipped roof instead of a gable hanging over thin air', () => {
    const ell = new Float32Array([0, 0, 10, 0, 10, 4, 4, 4, 4, 10, 0, 10]);
    const plan = planRoof(building({ ring: ell }));
    expect(plan.type).toBe('hip');
    if (plan.type === 'hip') {
      expect(plan.ridge).toBe(10);
      expect(plan.eave).toBeCloseTo(10 - 2 * 0.9); // no survey: ~42° over the 4 m wings
    }
    expect(planRoof(building({ roof: 'hipped' })).type).toBe('hip');
  });

  test('a block with a courtyard keeps it open and roofs around it', () => {
    const hole = new Float32Array([6, 6, 6, 14, 14, 14, 14, 6]);
    const b = building({ roof: 'gabled', ring: box(20, 20), holes: [hole], height: 15, eave: 11 });
    const plan = planRoof(b);
    expect(plan.type).toBe('hip');
    if (plan.type === 'hip') expect(plan.holes).toHaveLength(1);
    expect(windingAgreesWithNormals(b)).toBe(true);
    const flat = building({ roof: 'flat', ring: box(20, 20), holes: [hole] });
    // 8 walls, and a roof ring of 8 triangles around the hole.
    expect(buildingsGeometry([flat]).surfaces.getAttribute('position').count).toBe((8 * 2 + 8) * 3);
  });
});

describe('cutAt', () => {
  test('splits a roof face where it reaches its rise, and reports the cut line', () => {
    const face = [0, 0, 0, 10, 0, 0, 5, 5, 5];
    const { below, above, cuts } = cutAt(face, 2);
    expect(below.length / 3).toBe(4);
    expect(above.length / 3).toBe(3);
    expect(cuts).toEqual([[8, 2, 2, 2]]);
    expect(cutAt(face, 9).above).toEqual([]);
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

  test('shops, cafés and offices mark their walls for a shop front', () => {
    const b = building({ kind: 'retail' });
    const facade = buildingsGeometry([b]).surfaces.getAttribute('facade');
    const values = new Set(Array.from({ length: facade.count }, (_, i) => facade.getX(i)));
    expect(values).toEqual(new Set([Math.fround(planRoof(b).eave + SHOP_FRONT), 0]));
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

const segments = (b: Building[]) =>
  buildingsGeometry(b).outlines.getAttribute('position').count / 2;

describe('outlines', () => {
  test('a flat box has its top and four corners outlined; the ground hides its base', () => {
    expect(segments([building({ roof: 'flat' })])).toBe(4 + 4);
  });

  test('a gabled house adds eaves, rakes and the ridge', () => {
    expect(segments([building({})])).toBe(8 + 2 * 3 + 1);
  });

  test('footprint jogs shorter than the ink threshold get no line', () => {
    // A 6 × 12 box with a 0.3 m notch in one corner: two tiny edges, two tiny corners' worth.
    const notched = new Float32Array([0, 0, 6, 0, 6, 11.7, 5.7, 11.7, 5.7, 12, 0, 12]);
    expect(segments([building({ roof: 'flat', ring: notched })])).toBe(4 + 6);
  });

  test('sheds and kiosks get no ink at all', () => {
    expect(segments([building({ roof: 'flat', ring: box(4, 4), height: 3 })])).toBe(0);
  });

  test('row houses of about the same height read as one facade', () => {
    const left = building({ id: 1, roof: 'flat', height: 10, ring: box(6, 12) });
    const right = building({
      id: 2,
      roof: 'flat',
      height: 9,
      ring: new Float32Array([6, 0, 12, 0, 12, 12, 6, 12]),
    });
    // Each loses its top line along the seam and the two corners on it.
    expect(segments([left, right])).toBe(2 * (8 - 3));
    // A neighbour well below: the taller house keeps its seam top and the corners above it,
    // the lower one tucks against it.
    const low = { ...right, height: 4 };
    expect(segments([left, low])).toBe(8 + 5);
  });

  test('gentle bends in a curved wall are not outlined as corners', () => {
    const arc = Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2;
      return [Math.cos(a) * 10, Math.sin(a) * 10];
    }).flat();
    const { outlines } = buildingsGeometry([
      building({ roof: 'flat', ring: new Float32Array(arc) }),
    ]);
    expect(outlines.getAttribute('position').count / 2).toBe(16);
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
    // 3 steps a side, a front and a back quad each, on both sides of both ends; walls, slopes.
    expect(surfaces.getAttribute('position').count).toBe((4 * 2 + 2 * 2 + 2 * 2 * 3 * 2 * 2) * 3);
    // Wall tops, corners, two eaves, ridge, then a riser and a tread per step.
    expect(outlines.getAttribute('position').count / 2).toBe(8 + 2 + 1 + 2 * 2 * 3 * 2);
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

describe('party walls', () => {
  // Two flat houses back to back along x = 6; the second is lower.
  const left = building({ id: 1, roof: 'flat', height: 10, ring: box(6, 12) });
  const right = building({
    id: 2,
    roof: 'flat',
    height: 6,
    ring: new Float32Array([6, 0, 12, 0, 12, 12, 6, 12]),
  });

  test('a wall shared with a lower neighbour only shows above it', () => {
    const walls = partyWalls([left, right]);
    const mesh = new MeshBuilder();
    addBuilding(mesh, new LineBuilder(), left, walls);
    const p = mesh.build().getAttribute('position');
    // Triangles lying in the seam's plane, x = 6.
    const seam = Array.from({ length: p.count / 3 }, (_, t) => [t * 3, t * 3 + 1, t * 3 + 2])
      .filter((tri) => tri.every((i) => p.getX(i) === 6))
      .flat();
    expect(seam.length).toBe(6);
    expect(Math.min(...seam.map((i) => p.getY(i)))).toBe(6);
  });

  test('a wall shared with a taller neighbour is not drawn at all', () => {
    const together = buildingsGeometry([left, right]).surfaces.getAttribute('position').count;
    const apart =
      buildingsGeometry([left]).surfaces.getAttribute('position').count +
      buildingsGeometry([right]).surfaces.getAttribute('position').count;
    // The lower house loses its whole seam wall, the taller one keeps a strip: one quad less.
    expect(together).toBe(apart - 6);
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

describe('hipped roofs', () => {
  const ell = new Float32Array([0, 0, 12, 0, 12, 5, 5, 5, 5, 12, 0, 12]);

  test('face outward, peak at the surveyed height and outline their hips', () => {
    const b = building({ ring: ell, roof: 'gabled', height: 12, eave: 8 });
    expect(windingAgreesWithNormals(b)).toBe(true);
    const { surfaces, outlines } = buildingsGeometry([b]);
    surfaces.computeBoundingBox();
    expect(surfaces.boundingBox!.max.y).toBeCloseTo(12);
    // Walls: 6 tops, 6 corners; plus the roof's hips, valley and ridges.
    expect(outlines.getAttribute('position').count / 2).toBeGreaterThan(12 + 4);
  });

  test('a wide block flattens off on top in the flat-roof colour', () => {
    const b = building({
      ring: box(40, 30),
      roof: 'hipped',
      height: 20,
      eave: 16,
      roofColor: 0x6c717c,
    });
    const plan = planRoof(b);
    expect(plan.type === 'hip' && plan.pitch).toBe(0.6);
    const g = buildingsGeometry([b]).surfaces;
    const y = g.getAttribute('position');
    const flatTop = Array.from({ length: y.count }, (_, i) => y.getY(i)).filter((v) => v === 20);
    expect(flatTop.length).toBeGreaterThan(3);
  });
});
