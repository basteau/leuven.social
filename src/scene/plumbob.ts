import { BufferGeometry, Color, Float32BufferAttribute, Mesh, MeshBasicMaterial } from 'three';

/**
 * The own player's indicator: a slim two-sided crystal hanging over its head, in the app's accent
 * blue (index.html's `--accent`), a Sims plumbob in the diorama's register. Eight facets, one
 * unlit material and one draw call for the whole game: it is made once and moved, never rebuilt.
 * Only the entry flagged `self` in the presence list (src/data/presence.ts) gets one, so remote
 * players, when they come, are drawn without it.
 */

/** The accent, and its lit and shaded facets (sRGB). */
export const PLUMBOB = { lit: 0x3e89d7, accent: 0x1d5c9b, shade: 0x053b6c } as const;

/** Half its height and its width at the waist (model metres, before scaling). */
const HALF = 0.4;
const WAIST = 0.23;
/** How far over the figure's head it hangs when level (m), and how it moves. */
export const HOVER = 0.8;
const BOB = 0.1;
const BOB_PER_SECOND = 1.6;
const SPIN_PER_SECOND = 0.9;

/**
 * How big it is for a view this tall at the spot (m), so it stays seen from the map's height as
 * from the street: never under life size.
 */
export const plumbobScale = (span: number): number => Math.max(1, span * 0.04);

/** Its lift over its resting height (m) and its turn (radians) `seconds` into the visit. */
export function plumbobFloat(
  seconds: number,
  reducedMotion: boolean,
): { lift: number; spin: number } {
  if (reducedMotion) return { lift: 0, spin: Math.PI / 4 };
  return {
    lift: Math.sin(seconds * BOB_PER_SECOND) * BOB,
    spin: seconds * SPIN_PER_SECOND,
  };
}

/** Eight triangles round a square waist; the facets facing the sun are lighter. */
export function plumbobGeometry(): BufferGeometry {
  const waist = [0, 1, 2, 3].map((i) => {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    return [Math.cos(a) * WAIST, 0, Math.sin(a) * WAIST] as const;
  });
  const positions: number[] = [];
  const colours: number[] = [];
  const color = new Color();
  const facet = (a: readonly number[], b: readonly number[], c: readonly number[], hex: number) => {
    positions.push(...a, ...b, ...c);
    color.setHex(hex);
    for (let i = 0; i < 3; i++) colours.push(color.r, color.g, color.b);
  };
  const top = [0, HALF, 0] as const;
  const bottom = [0, -HALF, 0] as const;
  const upper = [PLUMBOB.lit, PLUMBOB.accent, PLUMBOB.shade, PLUMBOB.accent];
  const lower = [PLUMBOB.accent, PLUMBOB.shade, PLUMBOB.shade, PLUMBOB.accent];
  for (let i = 0; i < 4; i++) {
    const [a, b] = [waist[i]!, waist[(i + 1) % 4]!];
    facet(top, b, a, upper[i]!);
    facet(bottom, a, b, lower[i]!);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
  return geometry;
}

export interface Plumbob {
  mesh: Mesh;
  /** Hangs it over a spot `height` m above where the figure's head tops out, at this scale. */
  place(x: number, y: number, z: number, scale: number, seconds: number): void;
  dispose(): void;
}

export function createPlumbob(reducedMotion: boolean): Plumbob {
  const material = new MeshBasicMaterial({ vertexColors: true, fog: false });
  const mesh = new Mesh(plumbobGeometry(), material);
  mesh.visible = false;
  mesh.frustumCulled = false;
  return {
    mesh,
    place(x, y, z, scale, seconds) {
      const { lift, spin } = plumbobFloat(seconds, reducedMotion);
      mesh.position.set(x, y + (HOVER + lift) * scale, z);
      mesh.rotation.y = spin;
      mesh.scale.setScalar(scale);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
