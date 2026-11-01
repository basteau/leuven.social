import { expect, test } from 'bun:test';

import type { Building } from '../data/city.ts';
import { LABEL_MARGIN, labelHeights, modelTop } from './label-anchors.ts';
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
  expect(
    labelHeights(
      [
        { x: 10, z: 10 },
        { x: 50, z: 10 },
      ],
      [building(1, 24)],
    ),
  ).toEqual([24 + LABEL_MARGIN, LABEL_MARGIN]);
});

test('a landmark is as tall as its highest spire', () => {
  const [id, model] = [...LANDMARK_MODELS].find(([, m]) =>
    m.parts.some((p) => p.type === 'spire'),
  )!;
  const top = modelTop(model);
  expect(top).toBeGreaterThan(model.base);
  expect(labelHeights([{ x: 10, z: 10 }], [building(id, 5)])).toEqual([top + LABEL_MARGIN]);
});
