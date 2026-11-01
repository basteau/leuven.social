import { expect, test } from 'bun:test';

import type { Building } from '../data/city.ts';
import { LABEL_MARGIN, labelHeight, modelTop } from './label-anchors.ts';
import { LANDMARK_MODELS } from './landmark-models.ts';

const building = (id: number, height: number): Building => ({
  id,
  tier: 'core',
  kind: 'church',
  roof: 'auto',
  height,
  eave: height,
  roofColor: null,
  ring: new Float32Array([0, 0, 20, 0, 20, 20, 0, 20]),
  holes: [],
});

test('a label on a building points just above its top, one on open ground just above it', () => {
  expect(labelHeight(10, 10, [building(1, 24)])).toBe(24 + LABEL_MARGIN);
  expect(labelHeight(50, 10, [building(1, 24)])).toBe(LABEL_MARGIN);
});

test('a landmark is as tall as its highest spire', () => {
  const [id, model] = [...LANDMARK_MODELS].find(([, m]) =>
    m.parts.some((p) => p.type === 'spire'),
  )!;
  const top = modelTop(model);
  expect(top).toBeGreaterThan(model.base);
  expect(labelHeight(10, 10, [building(id, 5)])).toBe(top + LABEL_MARGIN);
});
