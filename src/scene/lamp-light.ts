import type { Bounds, Building, Prop, ShopFront } from '../data/city.ts';
import { PLACES } from '../data/shop-kinds.ts';
import { frontPoint } from '../data/shops.ts';
import { FRONTS } from './palette.ts';

/**
 * The light of the street lamps and the lit shop fronts, baked into one texture over the city:
 * red, green and blue the light that falls there, alpha the height of the ground under it, so the
 * shaders can leave off 7 m up (LAMP_FRAGMENT in facade-material.ts). A surface multiplies it by
 * its own colour, so whatever is under a lamp is lit, walls, bikes and setts alike, where a mesh
 * of light would cover them, and stop dead at a kerb's few centimetres.
 */

/** Metres a texel: light falls off over several metres, and the filter does the rest. */
export const LIGHT_TEXEL = 2.5;

/** A street lamp's reach (m) and warm light, as the share of full each channel gets at its foot. */
export const LAMP_RAY = { radius: 11, light: [0.92, 0.66, 0.36] } as const;
/** The spill from a lit shop front: how far it reaches (m), out from a point this far off the wall. */
export const FRONT_RAY = {
  radius: 6.5,
  out: 1.5,
  warm: [0.6, 0.4, 0.2],
  cool: [0.36, 0.38, 0.38],
} as const;

/** The ground lit round a floodlit church or hall: a splash this far out, every so many metres. */
export const FLOOD = { every: 9, out: 2.5, radius: 13, light: [0.16, 0.12, 0.07] } as const;

export interface LightField {
  data: Uint8Array;
  width: number;
  height: number;
  minX: number;
  minZ: number;
  texel: number;
  /** The ground heights alpha runs between (m). */
  low: number;
  high: number;
}

interface LightSources {
  area: readonly Bounds[];
  props: readonly Pick<Prop, 'kind' | 'x' | 'z'>[];
  buildings: readonly Pick<Building, 'ring' | 'kind' | 'tier'>[];
  fronts: readonly ShopFront[];
}

export function bakeLight(
  city: LightSources,
  terrain: { height(x: number, z: number): number; lowest: number; highest: number },
): LightField {
  const minX = Math.min(...city.area.map((a) => a.minX));
  const minZ = Math.min(...city.area.map((a) => a.minZ));
  const width = Math.ceil((Math.max(...city.area.map((a) => a.maxX)) - minX) / LIGHT_TEXEL);
  const height = Math.ceil((Math.max(...city.area.map((a) => a.maxZ)) - minZ) / LIGHT_TEXEL);
  const data = new Uint8Array(width * height * 4);
  const [low, high] = [terrain.lowest - 1, terrain.highest + 1];

  const splat = (
    x: number,
    z: number,
    radius: number,
    [r, g, b]: readonly [number, number, number] | readonly number[],
  ) => {
    const ground = Math.max(1, Math.round(((terrain.height(x, z) - low) / (high - low)) * 255));
    // The ground's height a little past the light, so the filter never mixes it with nothing.
    const reach = Math.ceil(radius / LIGHT_TEXEL) + 2;
    const [cx, cz] = [(x - minX) / LIGHT_TEXEL - 0.5, (z - minZ) / LIGHT_TEXEL - 0.5];
    const [i0, i1] = [
      Math.max(0, Math.floor(cx - reach)),
      Math.min(width - 1, Math.ceil(cx + reach)),
    ];
    const [j0, j1] = [
      Math.max(0, Math.floor(cz - reach)),
      Math.min(height - 1, Math.ceil(cz + reach)),
    ];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = (i + j * width) * 4;
        data[k + 3] = Math.max(data[k + 3]!, ground);
        const d = (Math.hypot(i - cx, j - cz) * LIGHT_TEXEL) / radius;
        if (d >= 1) continue;
        const fall = (1 - d * d) * (1 - d * d) * 255;
        data[k] = Math.min(255, data[k]! + r! * fall);
        data[k + 1] = Math.min(255, data[k + 1]! + g! * fall);
        data[k + 2] = Math.min(255, data[k + 2]! + b! * fall);
      }
    }
  };

  for (const p of city.props)
    if (p.kind === 'lamp') splat(p.x, p.z, LAMP_RAY.radius, LAMP_RAY.light);
  // The ground round a floodlit church or hall.
  for (const b of city.buildings) {
    if (b.kind !== 'church' && !(b.kind === 'civic' && b.tier === 'hero')) continue;
    const { ring } = b;
    for (let i = 0; i < ring.length; i += 2) {
      const [ax, az] = [ring[i]!, ring[i + 1]!];
      const j = (i + 2) % ring.length;
      const [bx, bz] = [ring[j]!, ring[j + 1]!];
      const length = Math.hypot(bx - ax, bz - az);
      const steps = Math.floor(length / FLOOD.every);
      for (let k = 0; k <= steps; k++) {
        const t = steps ? k / steps : 0.5;
        const [nx, nz] = [(bz - az) / (length || 1), (ax - bx) / (length || 1)];
        splat(
          ax + (bx - ax) * t + nx * FLOOD.out,
          az + (bz - az) * t + nz * FLOOD.out,
          FLOOD.radius,
          FLOOD.light,
        );
      }
    }
  }
  for (const front of city.fronts) {
    const p = frontPoint(city.buildings[front.building]!.ring, front);
    // Lit fronts (and the doors of public places, by their lamps) warm the pavement before them.
    const lit = FRONTS[front.kind].lit || PLACES.has(front.kind);
    splat(
      p.x + p.nx * FRONT_RAY.out,
      p.z + p.nz * FRONT_RAY.out,
      FRONT_RAY.radius,
      lit ? FRONT_RAY.warm : FRONT_RAY.cool,
    );
  }
  return { data, width, height, minX, minZ, texel: LIGHT_TEXEL, low, high };
}
