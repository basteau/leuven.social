import { expect, test } from 'bun:test';

import { NEEDLE_HEIGHT, materialOf, monumentFromOsm, monumentKind, plinthOf } from './monuments.ts';

const art = (artwork_type: string, more: Record<string, string> = {}) => ({
  tourism: 'artwork',
  artwork_type,
  ...more,
});

test('each monument is the archetype its tags say', () => {
  expect(monumentKind({ amenity: 'fountain', ...art('sculpture') })).toBe('fountain'); // Fonske
  expect(monumentKind({ amenity: 'fountain', fountain: 'splash_pad' })).toBeNull();
  expect(monumentKind({ man_made: 'water_well', historic: 'yes' })).toBe('pump');
  expect(monumentKind(art('bust'))).toBe('bust');
  expect(monumentKind({ ...art('statue'), memorial: 'person', 'memorial:type': 'bust' })).toBe(
    'bust',
  );
  expect(monumentKind({ historic: 'yes', memorial: 'obelisk' })).toBe('column');
  expect(monumentKind({ historic: 'wayside_shrine' })).toBe('column');
  expect(monumentKind({ historic: 'memorial', memorial: 'war_memorial' })).toBe('stone');
  expect(monumentKind({ historic: 'memorial', memorial: 'cannon' })).toBe('stone');
  expect(monumentKind({ historic: 'memorial' })).toBe('stone');
  // On a wall or in the pavement, nothing stands free.
  expect(monumentKind({ historic: 'memorial', memorial: 'plaque' })).toBeNull();
  expect(monumentKind({ historic: 'memorial', memorial: 'stolperstein' })).toBeNull();
  expect(monumentKind(art('mural'))).toBeNull();
  expect(monumentKind(art('installation'))).toBeNull();
  expect(monumentKind({ amenity: 'bench' })).toBeNull();
});

test('a figure is a statue, several named a group; other sculpture is abstract', () => {
  expect(monumentKind(art('statue', { name: 'Justus Lipsius' }))).toBe('statue');
  expect(monumentKind({ historic: 'memorial', memorial: 'statue' })).toBe('statue');
  expect(monumentKind({ historic: 'statue' })).toBe('statue');
  expect(monumentKind(art('statue', { name: 'Jan Ceusters;Jan Govaerts' }))).toBe('group');
  expect(monumentKind(art('statue', { name: 'Man en vrouw' }))).toBe('group');
  // A subject is often a theme, not the people shown.
  expect(monumentKind(art('statue', { subject: 'University and Universality' }))).toBe('statue');
  // A sculpture cast or carved, or named a statue, is a figure; welded or untold, abstract.
  expect(monumentKind(art('sculpture', { material: 'bronze' }))).toBe('statue');
  expect(monumentKind(art('sculpture', { name: 'Standbeeld Pieter De Somer' }))).toBe('statue');
  expect(monumentKind(art('sculpture', { material: 'steel;stone' }))).toBe('sculpture');
  expect(monumentKind(art('sculpture'))).toBe('sculpture');
  expect(monumentKind(art('sculpture', { name: 'Totem', height: '23' }))).toBe('needle');
});

test('a monument is made of what OSM says, else what its kind usually is', () => {
  expect(materialOf('statue', {})).toBe('bronze');
  expect(materialOf('statue', { material: 'Marble' })).toBe('marble');
  // A figure's own material wins over its monument's (a bronze on a stone plinth).
  expect(materialOf('statue', { material: 'stone', 'memorial:material': 'bronze' })).toBe('bronze');
  expect(materialOf('sculpture', { material: 'weathering_steel' })).toBe('rust');
  expect(materialOf('sculpture', { material: 'aluminium' })).toBe('steel');
  expect(materialOf('sculpture', { material: 'glass' })).toBe('steel'); // not drawable: usual
  expect(materialOf('column', { 'building:material': 'limestone' })).toBe('stone');
  expect(materialOf('pump', {})).toBe('bluestone');
  expect(materialOf('pump', { material: 'arduin' })).toBe('bluestone');
  // A fountain's is what stands in its basin: a sculpture's, else water.
  expect(materialOf('fountain', { material: 'stone' })).toBe('water');
  expect(materialOf('fountain', { tourism: 'artwork' })).toBe('bronze');
  expect(materialOf('fountain', { tourism: 'artwork', material: 'stone' })).toBe('stone');
});

test('the LiDAR sizes a monument before its tag, within its kind’s bounds', () => {
  const lipsius = monumentFromOsm({ ...art('statue'), _height: '5.9', height: '3' })!;
  expect(lipsius.size).toBe(5.9);
  expect(monumentFromOsm({ ...art('statue'), height: '3' })!.size).toBe(3);
  expect(monumentFromOsm(art('statue'))!.size).toBe(4);
  // A duck on the quay is still a few pixels; a crown the LiDAR took for a statue is not 20 m.
  expect(monumentFromOsm({ ...art('statue'), _height: '0.8' })!.size).toBe(2.6);
  expect(monumentFromOsm({ ...art('statue'), _height: '20' })!.size).toBe(9);
  // Nonsense tags are ignored.
  expect(monumentFromOsm({ ...art('bust'), height: '300' })!.size).toBe(2.4);
  // The needle keeps its tagged height, whatever the LiDAR.
  const totem = monumentFromOsm(art('sculpture', { height: '23', _height: '11' }))!;
  expect([totem.kind, totem.size]).toEqual(['needle', 23]);
  expect(NEEDLE_HEIGHT).toBe(12);
  // A shrine by the road is a pillar, not an obelisk.
  expect(monumentFromOsm({ historic: 'wayside_shrine' })!.size).toBe(2.4);
  expect(monumentFromOsm({ historic: 'yes', memorial: 'obelisk' })!.size).toBe(6);
});

test('a monument stands on the GRB’s plinth when there is one, its long side across', () => {
  const plinth = { _bearing: '30.0', _length: '4.1', _width: '3.0' };
  const coutereel = monumentFromOsm({ ...art('statue'), ...plinth })!;
  expect([coutereel.width, coutereel.depth, coutereel.bearing]).toEqual([4.1, 3, '30.0']);
  // Unmeasured, a figure stands about as tall as its plinth is long.
  expect(coutereel.size).toBeCloseTo(4.92);
  // A square's paving is no plinth.
  const huge = monumentFromOsm({ ...art('statue'), _bearing: '0', _length: '45', _width: '30' })!;
  expect([huge.width, huge.depth]).toEqual([20, 20]);
  // Without one, its kind's, for its height.
  const lone = monumentFromOsm(art('statue'))!;
  expect([lone.width, lone.depth, lone.bearing]).toEqual([1.2, 1.2, undefined]);
});

test('every kind has a plinth that grows with it, within reason', () => {
  for (const kind of [
    'statue',
    'bust',
    'group',
    'sculpture',
    'column',
    'stone',
    'fountain',
    'pump',
    'needle',
  ] as const) {
    const [w, d] = plinthOf(kind, 4);
    expect(w).toBeGreaterThan(0.3);
    expect(d).toBeGreaterThan(0.3);
    expect(plinthOf(kind, 30)[0]).toBeLessThanOrEqual(6);
  }
  expect(plinthOf('group', 4)[0]).toBeGreaterThan(plinthOf('group', 4)[1]); // side by side
  expect(plinthOf('pump', 2.6)[1]).toBeGreaterThan(plinthOf('pump', 2.6)[0]); // room for the spout
});
