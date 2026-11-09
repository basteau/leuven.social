/**
 * A cell's street furniture and monuments: a chunk of its own, which the viewer loads once the
 * first frame is drawn (docs/RENDERING.md). What only shows up close (lamps, benches, racks,
 * statues) is one mesh that hides when zoomed out; what stands tall enough to show at every zoom
 * (the Totem's needle, a column of 12 m or more) is a second.
 */

import type { Prop } from '../data/city.ts';
import { pointInRing } from '../data/geometry.ts';
import { propFootprint } from '../data/props.ts';
import type { Terrain } from '../data/terrain.ts';
import type { Cell } from './cells.ts';
import { TREE_STRIDE } from '../data/trees.ts';
import { addContacts, addShores, addTreePits } from './contact.ts';
import { drawnGround } from './drawn-ground.ts';
import { bakeLight } from './lamp-light.ts';
import type { LayerHeights } from './ground.ts';
import type { MeshBuilder } from './mesh-builder.ts';
import { addLampGlow, addProp, isLarge } from './props.ts';
import { addCafeTable, addStorefronts } from './storefronts.ts';
import type { StorefrontKit } from './storefronts.ts';
import { PARASOLS, PROPS } from './palette.ts';

/**
 * Where a prop stands: the lowest ground under its footprint's corners, as drawn (the terrain
 * and the layer on it, `drawnGround`), so a bench or a monument's plinth runs into a slope rather
 * than over it, and stands on a square's setts rather than in them.
 */
export function propBase(ground: Pick<Terrain, 'height'>, p: Prop): number {
  const { x, z, fx, fz, u0, u1, v0, v1 } = propFootprint(p);
  let lowest = Infinity;
  for (const u of [u0, u1]) {
    for (const v of [v0, v1]) {
      lowest = Math.min(lowest, ground.height(x - fz * u + fx * v, z + fx * u + fz * v));
    }
  }
  return lowest;
}

export interface Furniture {
  /** What shows from zoom 2 on: the props, and the shop fronts' signs and terraces. */
  near: MeshBuilder;
  /** Where each parked bike is drawn in `near` (`PARKED`). */
  bikes: Float32Array;
  /** The shop fronts' awnings, which carry their kind in the `facade` attribute, if any. */
  awnings: MeshBuilder | null;
  /** The dark at the foot of the walls and under the racks (contact.ts). */
  contact: MeshBuilder;
  /** What shows at every zoom, or null where nothing in the cell is that tall. */
  tall: MeshBuilder | null;
  /** The lanterns lit at night (`addLampGlow`), or null without a lamp. */
  glow: MeshBuilder | null;
}

/**
 * What the chunk takes from the engine rather than importing it: a module the engine, the
 * avatar's chunk and this one all import would be split into a chunk of its own.
 */
export interface FurnitureKit extends StorefrontKit {
  MeshBuilder: typeof MeshBuilder;
  terrain: Terrain;
  /** How high each ground layer is drawn (`LAYER_Y` in ground.ts). */
  layers: LayerHeights;
}

/**
 * A cell's furniture, each piece standing on the ground drawn under it (`propBase`), and each
 * parked bike on the ground under its own wheels.
 */
export function buildFurniture(cell: Cell, kit: FurnitureKit): Furniture {
  const { MeshBuilder, terrain } = kit;
  const near = new MeshBuilder();
  const bikes: number[] = [];
  const drawn = drawnGround(terrain, cell, kit.layers);
  let tall: MeshBuilder | null = null;
  let glow: MeshBuilder | null = null;
  const open = (x: number, z: number) => !cell.buildings.some((b) => pointInRing(b.ring, x, z));
  for (const p of cell.props) {
    const mesh = isLarge(p) ? (tall ??= new MeshBuilder()) : near;
    mesh.lift = propBase(drawn, p);
    addProp(mesh, p, mesh === near ? bikes : undefined, drawn.height, open);
    if (p.kind === 'lamp') {
      glow ??= new MeshBuilder();
      glow.lift = mesh.lift;
      addLampGlow(glow, p);
    }
  }
  // A table under each café parasol, its chairs in the café's colour (wood under cream).
  for (const p of cell.parasols) {
    const seed = Math.round(p.x * 7.3 + p.z * 13.1);
    near.lift = drawn.height(p.x, p.z);
    const chair = p.color === PARASOLS[0] ? PROPS.wood : p.color;
    addCafeTable(near, p.x, p.z, p.ux, p.uz, 2 + (((seed % 3) + 3) % 3), chair, seed, false);
  }
  const awnings = cell.fronts.length > 0 ? new MeshBuilder() : null;
  if (awnings) addStorefronts(near, awnings, cell.fronts, kit, drawn.height);
  const contact = new MeshBuilder();
  addContacts(contact, cell.buildings, terrain.height.bind(terrain));
  near.lift = 0;
  addTreePits(near, cell.trees, TREE_STRIDE, kit.layers.roads - 0.001, drawn.height, drawn.layer);
  addShores(contact, near, cell.ground.water, cell.bounds, terrain.height.bind(terrain));
  return { near, bikes: new Float32Array(bikes), awnings, contact, tall, glow };
}

// What the viewer reads off this chunk once it has loaded: the ground as drawn, which the avatar
// and the bikes stand on too, and the lamps' light, baked the first time it's dark.
export { drawnGround, bakeLight };
