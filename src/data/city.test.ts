import { expect, test } from 'bun:test';

import { kindFromOsm, roofFromOsm, roofFromSurvey } from './city.ts';

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
