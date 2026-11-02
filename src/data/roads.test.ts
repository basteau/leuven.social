import { expect, test } from 'bun:test';

import { carriagewayKind, crossingMarking, surfaceOf } from './roads.ts';

test('carriageways by surface, then by class', () => {
  expect(carriagewayKind('car', { highway: 'residential', surface: 'sett' })).toBe('street');
  expect(carriagewayKind('car', { highway: 'living_street', surface: 'paving_stones' })).toBe(
    'street',
  );
  expect(carriagewayKind('car', { highway: 'secondary', surface: 'asphalt' })).toBe('main');
  expect(carriagewayKind('car', { highway: 'primary_link' })).toBe('main');
  expect(carriagewayKind('car', { highway: 'residential', surface: 'asphalt' })).toBe('street');
  expect(carriagewayKind('car', {})).toBe('street');
});

test('pedestrian streets are paved unless cobbled; cycle tracks are cycle tracks', () => {
  expect(carriagewayKind('pedestrian', { highway: 'pedestrian' })).toBe('pedestrian');
  expect(carriagewayKind('pedestrian', { highway: 'pedestrian', surface: 'cobblestone' })).toBe(
    'pedestrian',
  );
  expect(carriagewayKind('cycle', { highway: 'cycleway', surface: 'sett' })).toBe('cycleway');
});

test('crossing paint: the markings tag wins, then the crossing type', () => {
  expect(crossingMarking({ footway: 'crossing', 'crossing:markings': 'zebra' })).toBe('zebra');
  expect(crossingMarking({ footway: 'crossing', 'crossing:markings': 'no' })).toBeNull();
  expect(crossingMarking({ cycleway: 'crossing', 'crossing:markings': 'dashes' })).toBe(
    'bike-crossing',
  );
  expect(crossingMarking({ highway: 'cycleway', 'crossing:markings': 'yes' })).toBe(
    'bike-crossing',
  );
  expect(crossingMarking({ footway: 'crossing', crossing: 'uncontrolled' })).toBe('zebra');
  expect(crossingMarking({ footway: 'crossing', crossing: 'traffic_signals' })).toBe('zebra');
  expect(crossingMarking({ cycleway: 'crossing', crossing: 'traffic_signals' })).toBe(
    'bike-crossing',
  );
  expect(crossingMarking({ footway: 'crossing', crossing: 'unmarked' })).toBeNull();
  expect(crossingMarking({ footway: 'crossing' })).toBeNull();
});

test('every way is made of something: its surface tag, else what its kind usually is', () => {
  expect(surfaceOf({ surface: 'asphalt' })).toBe('asphalt');
  expect(surfaceOf({ surface: 'concrete:lanes' })).toBe('concrete');
  expect(surfaceOf({ surface: 'cobblestone' })).toBe('sett');
  expect(surfaceOf({ surface: 'paving_stones' })).toBe('paving');
  expect(surfaceOf({ surface: 'compacted' })).toBe('gravel');
  expect(surfaceOf({ surface: 'dirt' })).toBe('earth');
  expect(surfaceOf({ surface: 'ground;grass' })).toBe('earth');
  expect(surfaceOf({ surface: 'grass_paver' })).toBe('grass');
  // Untagged: a track or a park path is earth, a footway paving, a road asphalt.
  expect(surfaceOf({ highway: 'track' })).toBe('earth');
  expect(surfaceOf({ highway: 'path' })).toBe('earth');
  expect(surfaceOf({ highway: 'footway' })).toBe('paving');
  expect(surfaceOf({ highway: 'residential' })).toBe('asphalt');
  expect(surfaceOf({ surface: 'something_new', highway: 'track' })).toBe('earth');
  expect(surfaceOf({})).toBe('asphalt');
});
