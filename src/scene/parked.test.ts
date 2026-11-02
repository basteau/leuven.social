import { describe, expect, test } from 'bun:test';

import { buildFurniture } from './cells.ts';
import { PARKED, nearestParked, parkedHeading } from './parked.ts';
import type { Furniture } from './parked.ts';
import { PARKED as PROPS_PARKED } from './props.ts';

const furniture = (bikes: number[], box = { min: { x: -100, z: -100 }, max: { x: 100, z: 100 } }) =>
  ({ userData: { bikes: Float32Array.from(bikes) }, geometry: { boundingBox: box } }) as Furniture;
const bike = (x: number, z: number) => [0, 6, x, 0, z, 0, 0];
const skip = (bikes: Float32Array, at: number) => bikes[at + PARKED.x] === 2;

describe('parked bikes', () => {
  test('are read as the furniture writes them', () => {
    expect(JSON.stringify(PARKED)).toBe(JSON.stringify(PROPS_PARKED));
  });

  test('the nearest within reach, across furniture meshes, skipping what is taken', () => {
    const a = furniture([...bike(5, 0), ...bike(2, 0)]);
    const b = furniture(bike(0, 3));
    const children = [
      { userData: {}, geometry: {} },
      a,
      b,
      { userData: {}, geometry: { boundingBox: null } },
    ];
    expect(nearestParked(children, 0, 0, 30)).toMatchObject({ mesh: a, at: 7, distance: 2 });
    expect(nearestParked(children, 0, 0, 1.5)).toBeNull();
    expect(nearestParked(children, 0, 0, 30, skip)).toMatchObject({ mesh: b, distance: 3 });
  });

  test('furniture far outside reach is not even looked through', () => {
    const far = furniture(bike(500, 0), { min: { x: 490, z: -10 }, max: { x: 510, z: 10 } });
    expect(nearestParked([far], 0, 0, 25)).toBeNull();
    expect(nearestParked([far], 480, 0, 25)).toMatchObject({ distance: 20 });
  });

  test('a parked bike’s heading is the walker’s: 0 facing +z, π/2 facing +x', () => {
    expect(parkedHeading(Math.PI / 2)).toBeCloseTo(0);
    expect(parkedHeading(0)).toBeCloseTo(Math.PI / 2);
  });

  test('finds the bikes a real rack parks', () => {
    const cell = {
      props: [{ kind: 'bikes', x: 10, z: 20, angle: 0, size: 6, fill: 1 }],
    } as unknown as Parameters<typeof buildFurniture>[0];
    const { mesh, bikes } = buildFurniture(cell);
    const built = mesh.build();
    const found = nearestParked([{ userData: { bikes }, geometry: built }], 10, 20, 5);
    expect(found).not.toBeNull();
    expect(bikes[found!.at + PARKED.to]! - bikes[found!.at + PARKED.from]!).toBeGreaterThan(100);
  });
});
