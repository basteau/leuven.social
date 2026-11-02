/**
 * A cell's street furniture and monuments: a chunk of its own, which the viewer loads once the
 * first frame is drawn (docs/RENDERING.md). What only shows up close (lamps, benches, racks,
 * statues) is one mesh that hides when zoomed out; what stands tall enough to show at every zoom
 * (the Totem's needle, a column of 12 m or more) is a second.
 */

import type { Prop } from '../data/city.ts';
import { propFootprint } from '../data/props.ts';
import type { Terrain } from '../data/terrain.ts';
import type { Cell } from './cells.ts';
import type { MeshBuilder } from './mesh-builder.ts';
import { addProp, isLarge } from './props.ts';
import { addStorefronts } from './storefronts.ts';
import type { StorefrontKit } from './storefronts.ts';

/**
 * Where a prop stands: the lowest ground under its footprint's corners, so a bench or a
 * monument's plinth runs into a slope rather than over it.
 */
export function propBase(terrain: Terrain, p: Prop): number {
  const { x, z, fx, fz, u0, u1, v0, v1 } = propFootprint(p);
  const ring = [u0, u1].flatMap((u) =>
    [v0, v1].flatMap((v) => [x - fz * u + fx * v, z + fx * u + fz * v]),
  );
  return terrain.base(ring);
}

export interface Furniture {
  /** What shows from zoom 2 on: the props, and the shop fronts' signs and terraces. */
  near: MeshBuilder;
  /** Where each parked bike is drawn in `near` (`PARKED`). */
  bikes: Float32Array;
  /** The shop fronts' awnings, which carry their kind in the `facade` attribute, if any. */
  awnings: MeshBuilder | null;
  /** What shows at every zoom, or null where nothing in the cell is that tall. */
  tall: MeshBuilder | null;
}

/**
 * What the chunk takes from the engine rather than importing it, as the plates do: a module
 * the engine, walk mode and this chunk all import would be split into a chunk of its own.
 */
export interface FurnitureKit extends StorefrontKit {
  MeshBuilder: typeof MeshBuilder;
  terrain: Terrain;
}

/** A cell's furniture, each piece standing on the ground under it (`propBase`). */
export function buildFurniture(cell: Cell, kit: FurnitureKit): Furniture {
  const { MeshBuilder, terrain } = kit;
  const near = new MeshBuilder();
  const bikes: number[] = [];
  let tall: MeshBuilder | null = null;
  for (const p of cell.props) {
    const mesh = isLarge(p) ? (tall ??= new MeshBuilder()) : near;
    mesh.lift = propBase(terrain, p);
    addProp(mesh, p, mesh === near ? bikes : undefined);
  }
  const awnings = cell.fronts.length > 0 ? new MeshBuilder() : null;
  if (awnings) addStorefronts(near, awnings, cell.fronts, kit);
  return { near, bikes: new Float32Array(bikes), awnings, tall };
}
