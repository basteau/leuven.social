import type { City } from '../data/city.ts';
import { orientedRect, pointInRing } from '../data/geometry.ts';
import type { LineBuilder, MeshBuilder, V3 } from './mesh-builder.ts';
import { PARASOLS, pick } from './palette.ts';

/** Squares that get café terraces, by name. Oude Markt is known as the longest bar in Europe. */
const TERRACE_SQUARES = new Set(['Oude Markt']);
/** Rows run along the square's long sides, this far in from its edge (m). */
const ROWS = [4, 8, 12];
const SPACING = 4.2;
/** Half the width of a parasol canopy. */
const CANOPY = 1.5;
/** Parasols this close to a tree trunk are left out. */
const TREE_CLEARANCE = 2.2;
/** Neighbouring parasols in a row belong to one café and share its colour. */
const PER_CAFE = 3;

export interface Parasol {
  x: number;
  z: number;
  /** Unit vector along the row, so canopies sit square to the square. */
  ux: number;
  uz: number;
  color: number;
}

/** Where the café parasols go: rows along the long sides of each terrace square. */
export function terraceParasols(city: City): Parasol[] {
  const parasols: Parasol[] = [];
  for (const [p, square] of city.plazas.entries()) {
    if (!TERRACE_SQUARES.has(city.streetNames[city.plazaNames[p] ?? -1] ?? '')) continue;
    const { cx, cz, ux, uz, halfLength, halfWidth } = orientedRect(square);
    const clearOfTrees = (x: number, z: number) => {
      for (let i = 0; i < city.trees.length; i += 2) {
        if (Math.hypot(city.trees[i]! - x, city.trees[i + 1]! - z) < TREE_CLEARANCE) return false;
      }
      return true;
    };
    const fits = (x: number, z: number) =>
      [1, -1].every((a) =>
        [1, -1].every((b) =>
          pointInRing(square, x + (a * ux - b * uz) * CANOPY, z + (a * uz + b * ux) * CANOPY),
        ),
      );
    for (const [row, inset] of ROWS.flatMap((d) => [d, -d]).entries()) {
      const v = Math.sign(inset) * (halfWidth - Math.abs(inset));
      for (let i = 0, u = -halfLength + SPACING; u <= halfLength - SPACING; u += SPACING, i++) {
        const x = cx + ux * u - uz * v;
        const z = cz + uz * u + ux * v;
        if (!fits(x, z) || !clearOfTrees(x, z)) continue;
        parasols.push({
          x,
          z,
          ux,
          uz,
          color: pick(PARASOLS, row * 101 + Math.floor(i / PER_CAFE)),
        });
      }
    }
  }
  return parasols;
}

/** A square canopy on a pole height a little over head height: four triangles and a rim. */
export function addParasol(mesh: MeshBuilder, lines: LineBuilder, p: Parasol): void {
  const rim = 2.3;
  const apex: V3 = [p.x, 3, p.z];
  const corners = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ].map(([a, b]): V3 => [
    p.x + (a! * p.ux - b! * p.uz) * CANOPY,
    rim,
    p.z + (a! * p.uz + b! * p.ux) * CANOPY,
  ]);
  for (let k = 0; k < 4; k++) {
    const a = corners[k]!;
    const b = corners[(k + 1) % 4]!;
    const out: V3 = [(a[0] + b[0]) / 2 - p.x, CANOPY, (a[2] + b[2]) / 2 - p.z];
    mesh.triangle(a, b, apex, p.color, out);
    lines.segment(a, b);
  }
}
