import { expect, test } from 'bun:test';

import { carriagewayKind, crossingMarking } from './roads.ts';

test('carriageways by surface, then by class', () => {
  expect(carriagewayKind('car', { highway: 'residential', surface: 'sett' })).toBe('sett');
  expect(carriagewayKind('car', { highway: 'living_street', surface: 'paving_stones' })).toBe(
    'paving',
  );
  expect(carriagewayKind('car', { highway: 'secondary', surface: 'asphalt' })).toBe('main');
  expect(carriagewayKind('car', { highway: 'primary_link' })).toBe('main');
  expect(carriagewayKind('car', { highway: 'residential', surface: 'asphalt' })).toBe('street');
  expect(carriagewayKind('car', {})).toBe('street');
});

test('pedestrian streets are paved unless cobbled; cycle tracks are cycle tracks', () => {
  expect(carriagewayKind('pedestrian', { highway: 'pedestrian' })).toBe('paving');
  expect(carriagewayKind('pedestrian', { highway: 'pedestrian', surface: 'cobblestone' })).toBe(
    'sett',
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
