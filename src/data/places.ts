/**
 * The named streets and squares as places to go: one spot for each name, for the menu's search.
 * A square's spot is the middle of its outline; a street's is the point on it nearest the middle
 * of all its stretches, so it's on the street even where the street bends round a block.
 */

import type { City } from './city.ts';

export interface Place {
  name: string;
  kind: 'street' | 'square';
  x: number;
  z: number;
}

type PlaceData = Pick<City, 'streetNames' | 'streets' | 'plazas' | 'plazaNames'>;

/** Every named place once, in the names' order (sorted); a name that's a square is a square. */
export function placesOf(city: PlaceData): Place[] {
  const squares = new Map<number, [number, number]>();
  city.plazas.forEach((ring, i) => {
    const name = city.plazaNames[i] ?? -1;
    if (name < 0 || squares.has(name) || ring.length < 2) return;
    let [x, z] = [0, 0];
    for (let k = 0; k < ring.length; k += 2) [x, z] = [x + ring[k]!, z + ring[k + 1]!];
    squares.set(name, [x / (ring.length / 2), z / (ring.length / 2)]);
  });
  const lines = new Map<number, Float32Array[]>();
  for (const { name, line } of city.streets) {
    if (line.length < 2) continue;
    const list = lines.get(name);
    if (list) list.push(line);
    else lines.set(name, [line]);
  }
  return city.streetNames.flatMap((name, i): Place[] => {
    const square = squares.get(i);
    if (square) return [{ name, kind: 'square', x: square[0], z: square[1] }];
    const stretches = lines.get(i);
    if (!stretches) return [];
    let [sx, sz, n] = [0, 0, 0];
    for (const line of stretches) {
      for (let k = 0; k < line.length; k += 2, n++) [sx, sz] = [sx + line[k]!, sz + line[k + 1]!];
    }
    const [cx, cz] = [sx / n, sz / n];
    let best: [number, number] = [stretches[0]![0]!, stretches[0]![1]!];
    let nearest = Infinity;
    for (const line of stretches) {
      for (let k = 0; k < line.length; k += 2) {
        const d = (line[k]! - cx) ** 2 + (line[k + 1]! - cz) ** 2;
        if (d < nearest) [nearest, best] = [d, [line[k]!, line[k + 1]!]];
      }
    }
    return [{ name, kind: 'street', x: best[0], z: best[1] }];
  });
}
