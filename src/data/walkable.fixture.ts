/** A tiny town for the walking tests. */

import type { Building } from './city.ts';
import type { WalkLayers } from './walkable.ts';

const rect = (x0: number, z0: number, x1: number, z1: number) =>
  Float32Array.of(x0, z0, x1, z0, x1, z1, x0, z1);

const building = (ring: Float32Array, height = 12): Building => ({
  id: 1,
  tier: 'core',
  kind: 'house',
  roof: 'flat',
  height,
  eave: height,
  roofColor: null,
  ring,
  holes: [],
});

/**
 * A street from west to east across two tiles, a house standing in its northern half, a
 * square to the south, a footpath running north off the street and a closed garden beyond.
 */
export const town: WalkLayers = {
  bounds: { minX: 0, minZ: 0, maxX: 200, maxZ: 120 },
  roads: [rect(10, 40, 190, 50)],
  plazas: [rect(60, 50, 90, 80), rect(150, 100, 160, 110)],
  paths: [{ width: 1, paved: true, line: Float32Array.of(20, 41, 20, 10, 40, 5) }],
  buildings: [building(rect(40, 38, 60, 45), 15.2)],
};
