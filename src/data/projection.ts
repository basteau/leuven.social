/**
 * WGS84 → local metres around Grote Markt, the same frame tools/build_leuven_data.py writes.
 * An equirectangular approximation: within 0.1% over the few kilometres the game covers.
 */

export const ORIGIN = { lon: 4.70139, lat: 50.87917 } as const;

const KX = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const KZ = 110_574;

export function toLocal(lon: number, lat: number): [x: number, z: number] {
  return [(lon - ORIGIN.lon) * KX, (ORIGIN.lat - lat) * KZ];
}

export function toLonLat(x: number, z: number): [lon: number, lat: number] {
  return [ORIGIN.lon + x / KX, ORIGIN.lat - z / KZ];
}
