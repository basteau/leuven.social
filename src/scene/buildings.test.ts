import { describe, expect, test } from 'bun:test';

import type { Building } from '../data/city.ts';
import {
  addBuilding,
  buildingsGeometry as indexed,
  cutAt,
  footing,
  partyWalls,
  planRoof,
} from './buildings.ts';
import type { RoofPlan } from './buildings.ts';
import { LANCET_BAY, bayTarget, fitBays, fitRun } from './facade-bays.ts';
import { LANDMARK_MODELS } from './landmark-models.ts';
import { LANCETS, ORNATE, shopFront, ROOF_FLAT, WALL_PLAIN, pitchedRoof } from './facade-codes.ts';
import { Terrain } from '../data/terrain.ts';
import { LIFT_UNIT, LineBuilder, MeshBuilder, unindexed } from './mesh-builder.ts';
import { pick } from './palette.ts';

/** The geometry as the tests read it, triangle by triangle and segment by segment. */
const buildingsGeometry = (...args: Parameters<typeof indexed>) => {
  const { surfaces, outlines } = indexed(...args);
  return { surfaces: unindexed(surfaces), outlines: unindexed(outlines) };
};

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

  test('a roof the LiDAR saw facing along the plot turns its ridge across it', () => {
    // A 6 m wide, 12 m deep row house: its ridge runs along z, or across along x when turned.
    const along = planRoof(building({ roof: 'gabled' }));
    const across = planRoof(building({ roof: 'across' }));
    expect(along.type === 'gable' && Math.abs(along.rect.uz)).toBeCloseTo(1);
    expect(across.type === 'gable' && Math.abs(across.rect.ux)).toBeCloseTo(1);
    if (across.type === 'gable') {
      expect([across.rect.halfLength, across.rect.halfWidth]).toEqual([3, 6]);
      // The rise comes from the 6 m half span now, capped by half the height.
      expect(across.eave).toBeCloseTo(5);
    }
    expect(windingAgreesWithNormals(building({ roof: 'across' }))).toBe(true);
    // A span too wide for a gable keeps its ridge along; an odd shape still gets a hip.
    const deep = planRoof(building({ roof: 'across', ring: box(8, 24) }));
    expect(deep.type === 'gable' && Math.abs(deep.rect.uz)).toBeCloseTo(1);
    const ell = new Float32Array([0, 0, 10, 0, 10, 4, 4, 4, 4, 10, 0, 10]);
    expect(planRoof(building({ roof: 'across', ring: ell })).type).toBe('hip');
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

/** The `facade` values a building's surfaces carry. */
function facades(b: Building): Set<number> {
  const facade = buildingsGeometry([b]).surfaces.getAttribute('facade');
  return new Set(Array.from({ length: facade.count }, (_, i) => facade.getX(i)));
}

describe('buildingsGeometry', () => {
  test('a flat box is 4 walls and a 2-triangle roof, all facing outward', () => {
    const b = building({ roof: 'flat' });
    expect(buildingsGeometry([b]).surfaces.getAttribute('position').count).toBe((4 * 2 + 2) * 3);
    expect(windingAgreesWithNormals(b)).toBe(true);
  });

  test('a gabled house faces outward too and peaks at its height', () => {
    const b = building({ kind: 'other' }); // no chimney, which would stand higher
    expect(windingAgreesWithNormals(b)).toBe(true);
    const g = buildingsGeometry([b]).surfaces;
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y).toBeCloseTo(10);
  });

  test('walls carry their top height for the window shader; roofs their ridge and their courses', () => {
    const plan = planRoof(building({}));
    const facade = buildingsGeometry([building({})]).surfaces.getAttribute('facade');
    const values = new Set(Array.from({ length: facade.count }, (_, i) => facade.getX(i)));
    const ridge = plan.type === 'gable' ? plan.ridge : plan.eave;
    for (const code of [Math.fround(plan.eave), WALL_PLAIN, Math.fround(pitchedRoof(ridge))]) {
      expect(values).toContain(code);
    }
  });

  test('a shop front marks the walls that face its street with its kind; the back stays plain', () => {
    const front = { building: 0, edge: 0, along: 3, kind: 'bakery' as const, terrace: false };
    const b = building({ kind: 'retail', roof: 'flat', front });
    const g = buildingsGeometry([b]).surfaces;
    const [facade, position] = [g.getAttribute('facade'), g.getAttribute('position')];
    const bakery = shopFront(5, 10);
    expect(facades(b)).toEqual(new Set([bakery, 10, ROOF_FLAT + 0.5]));
    // Only the wall along z = 0, whose normal is the front's, carries it.
    for (let i = 0; i < facade.count; i++) {
      if (facade.getX(i) === bakery) expect(position.getZ(i)).toBe(0);
    }
    // A building tagged retail with no shop mapped in it has plain windows.
    expect(facades(building({ kind: 'retail', roof: 'flat' }))).toEqual(
      new Set([10, ROOF_FLAT + 0.5]),
    );
  });

  test('churches mark their walls for lancets; sheds get no windows', () => {
    expect(facades(building({ kind: 'church', roof: 'flat' }))).toEqual(
      new Set([10 + LANCETS, ROOF_FLAT + 0.5]),
    );
    expect(facades(building({ kind: 'shed', roof: 'flat' }))).toEqual(
      new Set([WALL_PLAIN, ROOF_FLAT + 0.5]),
    );
  });

  test('a church tower stands square to its footprint and spires up to its tip', () => {
    const tower = { x: 5, z: 2, radius: 2.5, top: 18, tip: 30 };
    const b = building({ kind: 'church', roof: 'flat', ring: box(6, 12), tower });
    expect(windingAgreesWithNormals(b)).toBe(true);
    const plain = buildingsGeometry([{ ...b, tower: undefined }]).surfaces;
    const { surfaces } = buildingsGeometry([b]);
    // Four walls and four spire faces, 36 vertices, and the cross on its tip, two bars of 30.
    expect(surfaces.getAttribute('position').count - plain.getAttribute('position').count).toBe(
      36 + 60,
    );
    surfaces.computeBoundingBox();
    expect(surfaces.boundingBox!.max.y).toBeCloseTo(31.9);
    // Square to the footprint: its corners stand 2.5/√2 m off its centre along x and z.
    expect(surfaces.boundingBox!.max.x).toBeCloseTo(5 + 2.5 / Math.SQRT2);
    // A slender spire on the ridge is an octagon.
    const turret = buildingsGeometry([{ ...b, tower: { ...tower, radius: 1.4 } }]).surfaces;
    expect(turret.getAttribute('position').count - plain.getAttribute('position').count).toBe(
      72 + 60,
    );
    // A tower with no spire to speak of has no cross either.
    const flat = buildingsGeometry([{ ...b, tower: { ...tower, tip: 19 } }]).surfaces;
    expect(flat.getAttribute('position').count - plain.getAttribute('position').count).toBe(36);
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
    // A 6 × 12 box with a 0.3 m notch in one corner: two tiny edges get no top, and the notch's
    // inner corner, between two of them, no line up it.
    const notched = new Float32Array([0, 0, 6, 0, 6, 11.7, 5.7, 11.7, 5.7, 12, 0, 12]);
    expect(segments([building({ roof: 'flat', ring: notched })])).toBe(4 + 5);
  });

  test('a saw-tooth facade gets no line up its jogs, only at its real corners', () => {
    // A block whose front steps back in 1 m by 1.5 m teeth: the five corners between two short
    // walls get no line; the block's own five corners keep theirs, and every wall its top.
    const ring = [0, -10, 10, -10, 10, 4.5, 9, 4.5, 9, 3, 8, 3, 8, 1.5, 7, 1.5, 7, 0, 0, 0];
    const b = building({ roof: 'flat', ring: new Float32Array(ring) });
    expect(segments([b])).toBe(10 + 5);
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

  test('a ridge turned across the plot gets plain gables: they stand on the party walls', () => {
    const plan = planRoof(wide({ id: steppedId, tier: 'hero', roof: 'across', ring: box(8, 14) }));
    expect(plan.type === 'gable' && plan.stepped).toBe(false);
  });

  test('narrow gables stay plain: the steps would be smaller than a pixel', () => {
    const plan = planRoof(building({ id: steppedId, tier: 'hero', ring: box(4, 12) }));
    expect(plan.type === 'gable' && plan.stepped).toBe(false);
  });

  test('steps climb above the ridge, face outward and replace the gable triangles', () => {
    const b = wide({ id: steppedId, tier: 'hero', kind: 'other' }); // bare of stacks and dormers
    expect(windingAgreesWithNormals(b)).toBe(true);
    const { surfaces, outlines } = buildingsGeometry([b]);
    surfaces.computeBoundingBox();
    expect(surfaces.boundingBox!.max.y).toBeGreaterThan(14);
    // 3 steps a side, a front and a back quad each, on both sides of both ends; walls, slopes.
    expect(surfaces.getAttribute('position').count).toBe((4 * 2 + 2 * 2 + 2 * 2 * 3 * 2 * 2) * 3);
    // Wall tops, corners, two eaves, ridge, then a riser and a tread per step.
    expect(outlines.getAttribute('position').count / 2).toBe(8 + 2 + 1 + 2 * 2 * 3 * 2);
  });

  test('both faces lie on the plane its outline is drawn on, none set back into the house', () => {
    const b = wide({ id: steppedId, tier: 'hero', kind: 'other' });
    const { rect } = planRoof(b) as Extract<RoofPlan, { type: 'gable' }>;
    const { surfaces } = buildingsGeometry([b]);
    const p = surfaces.getAttribute('position');
    const n = surfaces.getAttribute('normal');
    // Every vertex of a face across the ridge axis (the two gable ends) is on the end plane.
    for (let i = 0; i < p.count; i++) {
      const along = (p.getX(i) - rect.cx) * rect.ux + (p.getZ(i) - rect.cz) * rect.uz;
      if (Math.abs(n.getX(i) * rect.ux + n.getZ(i) * rect.uz) > 0.99) {
        expect(Math.abs(along)).toBeCloseTo(rect.halfLength, 3);
      }
    }
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
    // The Stadhuis: civic Gothic niches on its walls.
    expect(model.windows).toBe('ornate');
    expect(Array.from({ length: facade.count }, (_, i) => facade.getX(i))).toContain(
      model.base + ORNATE,
    );
  });

  test('opened for a room, it is its walls cut down, with no roof', () => {
    const b = building({ id, tier: 'hero', kind: 'civic', height: 30, ring });
    const mesh = new MeshBuilder();
    addBuilding(mesh, new LineBuilder(), b, undefined, 0, 8);
    const g = mesh.build({ keep: true });
    expect(g.boundingBox!.max.y).toBeCloseTo(8);
    const normal = g.getAttribute('normal');
    const ups = Array.from({ length: normal.count }, (_, i) => normal.getY(i));
    expect(ups.every((y) => Math.abs(y) < 0.01)).toBe(true); // walls only
    // Four walls, facing out.
    expect(mesh.indices).toBe(4 * 6);
  });
});

/** The bay byte of the walls at a footprint corner, as the geometry drew it. */
function baysAt(b: Building[], x: number, z: number): number[] {
  const g = buildingsGeometry(b).surfaces;
  const [p, bay] = [g.getAttribute('position'), g.getAttribute('bay')];
  const out: number[] = [];
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(p.getX(i) - x) + Math.abs(p.getZ(i) - z) < 1e-3 && p.getY(i) === 0) {
      out.push(bay.getX(i));
    }
  }
  return out;
}

describe('windows are laid in whole bays along each wall', () => {
  test('a wall runs from a whole bay to a whole bay, a number that fits it', () => {
    // 12 m along x = its first wall, from (0, 0) to (12, 0).
    const b = building({ roof: 'flat', ring: box(12, 6) });
    const start = baysAt([b], 0, 0).find((v) => v % 2 === 0)!;
    const end = baysAt([b], 12, 0).find((v) => (v - start) / 2 === fitBays(12, bayTarget(10)));
    expect(end).toBeDefined();
  });

  test('a wall too short for a window has no bays', () => {
    const narrow = building({ roof: 'flat', ring: box(1.2, 12) });
    const at0 = new Set(baysAt([narrow], 0, 0));
    const at1 = new Set(baysAt([narrow], 1.2, 0));
    // Its short sides (z = 0 here) start and end on the same number.
    expect([...at0].some((v) => at1.has(v))).toBe(true);
  });

  test('a church fits its lancets to its wall, not a house’s bays', () => {
    const church = building({ kind: 'church', roof: 'flat', ring: box(22, 8) });
    const bays = baysAt([church], 22, 0);
    expect(bays.some((v, _, all) => all.includes(v + 2 * fitBays(22, LANCET_BAY)))).toBe(false);
    const start = baysAt([church], 0, 0);
    expect(start.some((s) => bays.includes(s + 2 * fitBays(22, LANCET_BAY)))).toBe(true);
  });

  test('a wall starting against a neighbour is marked as a join, the wall ending there isn’t', () => {
    const left = building({ id: 1, roof: 'flat', ring: box(6, 12) });
    const right = building({
      id: 2,
      roof: 'flat',
      ring: new Float32Array([6, 0, 12, 0, 12, 12, 6, 12]),
    });
    // The right house's first wall starts at the shared corner (6, 0): marked; the left house's
    // first wall ends there, so its own start, at (0, 0), is not.
    expect(baysAt([left, right], 6, 0).some((v) => v % 2 === 1)).toBe(true);
    expect(baysAt([left, right], 0, 0).every((v) => v % 2 === 0)).toBe(true);
    // The houses alone have no joins at all.
    expect(baysAt([right], 6, 0).every((v) => v % 2 === 0)).toBe(true);
  });

  test('a gently curved wall is laid out as one run, a corner ends it', () => {
    // Half a 10 m circle drawn as 8 facets, each too short alone for its share, then two walls.
    const curve = Array.from({ length: 9 }, (_, i) => {
      const a = (i / 8) * Math.PI;
      return [Math.cos(a) * -10, Math.sin(a) * 10];
    }).flat();
    const ring = new Float32Array([...curve, 10, 30, -10, 30]);
    const b = building({ roof: 'flat', ring, height: 12 });
    const g = buildingsGeometry([b]).surfaces;
    const [p, bay] = [g.getAttribute('position'), g.getAttribute('bay')];
    // Each wall's two triangles start at its first corner and give its bays from there.
    let total = 0;
    for (let i = 0; i + 2 < p.count; i += 6) {
      if (p.getY(i) === 0) total += (bay.getX(i + 1) - bay.getX(i)) / 2;
    }
    const facet = Math.hypot(curve[2]! - curve[0]!, curve[3]! - curve[1]!);
    const target = bayTarget(12);
    const expected =
      fitRun(
        Array.from({ length: 8 }, () => facet),
        target,
      ).reduce((a, n) => a + n, 0) +
      fitBays(Math.hypot(curve[16]! - 10, curve[17]! - 30), target) +
      fitBays(20, target) +
      fitBays(Math.hypot(-10 - curve[0]!, 30 - curve[1]!), target);
    expect(total).toBe(expected);
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
    const p = unindexed(mesh.build()).getAttribute('position');
    // Triangles lying in the seam's plane, x = 6.
    const seam = Array.from({ length: p.count / 3 }, (_, t) => [t * 3, t * 3 + 1, t * 3 + 2])
      .filter((tri) => tri.every((i) => p.getX(i) === 6))
      .flat();
    expect(seam.length).toBe(6);
    expect(Math.min(...seam.map((i) => p.getY(i)))).toBe(6);
  });

  test('neighbours on different ground compare their wall tops above Grote Markt', () => {
    // The lower house stands 3 m higher: its eaves are at 9, under the left one's 10.
    const walls = partyWalls([left, right], (b) => (b.id === 2 ? 3 : 0));
    const mesh = new MeshBuilder();
    addBuilding(mesh, new LineBuilder(), left, walls, 0);
    const p = unindexed(mesh.build()).getAttribute('position');
    const seam = Array.from({ length: p.count / 3 }, (_, t) => [t * 3, t * 3 + 1, t * 3 + 2])
      .filter((tri) => tri.every((i) => p.getX(i) === 6))
      .flat();
    expect(Math.min(...seam.map((i) => p.getY(i)))).toBe(9);
    // Seen from the right, standing at 3 m, the left house's 10 m eaves are 7 m up: over its 6.
    const other = new MeshBuilder();
    addBuilding(other, new LineBuilder(), right, walls, 3);
    expect(unindexed(other.build()).getAttribute('position').count).toBeLessThan(
      buildingsGeometry([right]).surfaces.getAttribute('position').count,
    );
  });

  test('a neighbour a few centimetres lower still hides the whole wall', () => {
    // Standing 4 cm lower down a slope, the right house's equal eaves leave a strip too thin
    // to draw; at 10 cm lower it shows.
    const equal = { ...right, height: 10 };
    const seamAt = (drop: number) => {
      const walls = partyWalls([left, equal], (b) => (b.id === 2 ? -drop : 0));
      const mesh = new MeshBuilder();
      addBuilding(mesh, new LineBuilder(), left, walls, 0);
      const p = unindexed(mesh.build()).getAttribute('position');
      return Array.from({ length: p.count / 3 }, (_, t) => [t * 3, t * 3 + 1, t * 3 + 2]).filter(
        (tri) => tri.every((i) => p.getX(i) === 6),
      ).length;
    };
    expect(seamAt(0.04)).toBe(0);
    expect(seamAt(0.1)).toBe(2);
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

const houses = (tier: Building['tier'], kind: Building['kind'] = 'house') =>
  Array.from({ length: 60 }, (_, id) => wide({ id, tier, kind, height: 14, eave: 10 }));
const peak = (b: Building) => {
  const g = buildingsGeometry([b]).surfaces;
  g.computeBoundingBox();
  return g.boundingBox!.max.y;
};
const vertices = (b: Building) => buildingsGeometry([b]).surfaces.getAttribute('position').count;
/** What the details add: the same house as a bare kind, with the same stepped gable if any. */
const extra = (b: Building) => vertices(b) - vertices({ ...b, kind: 'other' });
const plain = (b: Building) => {
  const plan = planRoof(b);
  return plan.type === 'gable' && !plan.stepped;
};

describe('roof details', () => {
  test('most houses in the centre get a chimney stack above the ridge, the fringe none', () => {
    const centre = houses('core')
      .filter(plain)
      .filter((b) => peak(b) > 14.5).length;
    expect(centre).toBeGreaterThan(25);
    expect(houses('fringe').every((b) => peak(b) === 14)).toBe(true);
    expect(
      houses('core', 'retail')
        .filter(plain)
        .every((b) => peak(b) === 14),
    ).toBe(true);
  });

  test('a stack is a box of five faces; a dormer adds a front, a pane, cheeks and a lid', () => {
    const counts = new Set(houses('core').map(extra));
    // Stacks: 0, 1 or 2 boxes of 5 quads (30 vertices each as triangles).
    expect(counts.has(30) || counts.has(60)).toBe(true);
    // A dormer: a front quad, its pane, two cheek triangles and a lid (6 + 6 + 3 + 3 + 6).
    expect([...counts].some((n) => n % 30 === 24)).toBe(true);
    // A roof window: one quad.
    expect([...counts].some((n) => n % 30 === 6)).toBe(true);
    for (const b of houses('core')) expect(windingAgreesWithNormals(b)).toBe(true);
  });

  test('a low or narrow roof gets no dormer, and a short ridge no stack', () => {
    const low = houses('core').map((b) => building({ ...b, height: 11.6, eave: 10 }));
    expect(low.every((b) => extra(b) % 30 !== 24)).toBe(true);
    const short = building({ ring: box(3, 2.4), height: 6, eave: 4 });
    expect(peak(short)).toBe(6);
  });
});

test('café parasols ride along in the buildings geometry', () => {
  const parasol = { x: 0, z: 0, ux: 1, uz: 0, color: 0xffffff };
  const without = buildingsGeometry([]).surfaces.getAttribute('position').count;
  expect(buildingsGeometry([], [parasol]).surfaces.getAttribute('position').count).toBe(
    without + 34 * 3,
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

test('a house stands on the lowest ground under its corners, down to a whole lift unit', () => {
  const slope = new Terrain({
    step: 10,
    minX: -60,
    minZ: -60,
    cols: 13,
    rows: 17,
    // Rising 0.1 m a metre to the east.
    heights: Float32Array.from({ length: 13 * 17 }, (_, k) => (k % 13) - 6),
  });
  // Its west corners are on 0.3 m of ground, its east ones higher.
  expect(footing(slope, [3, 0, 8, 0, 8, 5, 3, 5])).toBe(0);
  expect(footing(slope, [7, 0, 9, 0, 9, 5])).toBe(0.5);
  expect(footing(slope, [-3, 0, 0, 0, 0, 5])).toBe(-LIFT_UNIT);
});
