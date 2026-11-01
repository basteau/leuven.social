import { expect, test } from 'bun:test';

import {
  KINDS,
  ROOFS,
  kindFromOsm,
  pathFromOsm,
  railFromOsm,
  roofAcross,
  roofFromOsm,
  roofFromSurvey,
} from './city.ts';

test('OSM building values collapse into the kinds the renderer styles', () => {
  expect(kindFromOsm('terrace')).toBe('house');
  expect(kindFromOsm('dormitory')).toBe('apartments');
  expect(kindFromOsm('hotel')).toBe('retail');
  expect(kindFromOsm('cathedral')).toBe('church');
  expect(kindFromOsm('townhall')).toBe('civic');
  expect(kindFromOsm('garages')).toBe('shed');
  expect(kindFromOsm('yes')).toBe('other');
  expect(kindFromOsm(null)).toBe('other');
});

test('OSM roof shapes collapse into the roofs the renderer draws', () => {
  expect(roofFromOsm('flat')).toBe('flat');
  expect(roofFromOsm('saltbox')).toBe('gabled');
  expect(roofFromOsm('mansard')).toBe('hipped');
  expect(roofFromOsm(undefined)).toBe('auto');
});

test('inherited object keys are not mistaken for OSM values', () => {
  expect(kindFromOsm('constructor')).toBe('other');
  expect(roofFromOsm('toString')).toBe('auto');
});

test('the LiDAR slope survey decides the roof unless OSM tags it', () => {
  expect(roofFromSurvey(null, 0.8)).toBe('gabled');
  expect(roofFromSurvey(undefined, 0.1)).toBe('flat');
  expect(roofFromSurvey('flat', 0.9)).toBe('flat');
  expect(roofFromSurvey('hipped', 0)).toBe('hipped');
  expect(roofFromSurvey(null, null)).toBe('auto');
  expect(roofFromSurvey('dome')).toBe('auto');
});

test('paths of their own are drawn, sidewalks, crossings and tunnels are not', () => {
  expect(pathFromOsm({ highway: 'footway', surface: 'paving_stones' })).toEqual({
    width: 2,
    paved: true,
  });
  expect(pathFromOsm({ highway: 'path' })).toEqual({ width: 1.5, paved: false });
  expect(pathFromOsm({ highway: 'cycleway', width: '3.5', surface: 'asphalt' })).toEqual({
    width: 3.5,
    paved: true,
  });
  expect(pathFromOsm({ highway: 'track', width: 'narrow', surface: 'gravel' })).toEqual({
    width: 3,
    paved: false,
  });
  expect(pathFromOsm({ highway: 'footway', footway: 'sidewalk' })).toBeNull();
  expect(pathFromOsm({ highway: 'footway', footway: 'crossing' })).toBeNull();
  expect(pathFromOsm({ highway: 'cycleway', cycleway: 'crossing' })).toBeNull();
  expect(pathFromOsm({ highway: 'footway', tunnel: 'yes' })).toBeNull();
  expect(pathFromOsm({ highway: 'steps', layer: '-1' })).toBeNull();
  expect(pathFromOsm({ highway: 'pedestrian', area: 'yes' })).toBeNull();
  expect(pathFromOsm({ highway: 'residential' })).toBeNull();
  expect(pathFromOsm({})).toBeNull();
});

test('tracks above ground are drawn, tunnels and dead lines are not', () => {
  const main = { railway: 'rail', usage: 'main', electrified: 'contact_line', gauge: '1435' };
  expect(railFromOsm(main)).toEqual({ kind: 'main', bridge: false, electrified: true });
  expect(railFromOsm({ ...main, bridge: 'yes', layer: '1' })).toEqual({
    kind: 'main',
    bridge: true,
    electrified: true,
  });
  expect(railFromOsm({ railway: 'rail', service: 'crossover' })?.kind).toBe('main');
  expect(railFromOsm({ railway: 'rail', service: 'siding', electrified: 'no' })).toEqual({
    kind: 'yard',
    bridge: false,
    electrified: false,
  });
  expect(railFromOsm({ railway: 'rail', service: 'yard', bridge: 'no' })?.bridge).toBe(false);
  expect(railFromOsm({ ...main, tunnel: 'yes', layer: '-1' })).toBeNull();
  expect(railFromOsm({ railway: 'rail', service: 'yard', tunnel: 'building_passage' })).toBeNull();
  expect(railFromOsm({ ...main, covered: 'yes' })).toBeNull();
  expect(railFromOsm({ ...main, layer: '-1' })).toBeNull();
  expect(railFromOsm({ ...main, indoor: 'yes' })).toBeNull();
  expect(railFromOsm({ railway: 'abandoned' })).toBeNull();
  expect(railFromOsm({ railway: 'platform' })).toBeNull();
  expect(railFromOsm({})).toBeNull();
});

test('a gable turns across its footprint where the LiDAR saw its slopes face along it', () => {
  // A plot running north–south (long side along z): slopes facing east–west keep the ridge along
  // it, slopes facing north–south (90° from x) turn it across.
  const deep = { ux: 0, uz: 1 };
  expect(roofAcross('gabled', [0, 0.9], deep)).toBe('gabled');
  expect(roofAcross('gabled', [90, 0.9], deep)).toBe('across');
  expect(roofAcross('gabled', [100, 0.9], { ux: 0, uz: -1 })).toBe('across');
  // A hip faces every way, and a broken roof too weakly one way to say.
  expect(roofAcross('gabled', [90, 0.2], deep)).toBe('gabled');
  expect(roofAcross('gabled', [45, 0.9], deep)).toBe('gabled');
  // Only pitched roofs turn, and only surveyed ones.
  expect(roofAcross('flat', [90, 0.9], deep)).toBe('flat');
  expect(roofAcross('hipped', [90, 0.9], deep)).toBe('hipped');
  expect(roofAcross('gabled', undefined, deep)).toBe('gabled');
});

test('kinds and roofs fit the three bits each the city format packs them in', () => {
  expect(KINDS.length).toBeLessThanOrEqual(8);
  expect(ROOFS.length).toBeLessThanOrEqual(8);
});
