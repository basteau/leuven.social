/**
 * Roof colours as the orthophoto saw them, made comparable. The winter mosaic is hazy and cool:
 * red-brown tiles come out a faint purple-grey that sits nearer slate than tile. Flat roofs are
 * mostly grey (gravel, bitumen, membrane), so their median colour is the photo's grey; taking it
 * out and stretching what remains brings the tile reds and slate blues back apart. Then row
 * houses that look alike are pulled together, so a terrace roofed in one material doesn't
 * flicker between two swatches.
 */

import { fromOklab, toOklab } from './colour.ts';
import type { Lab } from './colour.ts';

/** How much the hue left after white balance is stretched. */
const CHROMA_STRETCH = 2;
/** Neighbours closer than this (Oklab ΔE, after the stretch) count as the same roofing. */
const SAME_ROOFING = 0.05;

interface Roof {
  /** 0xRRGGBB as sampled, or null. */
  roofColor: number | null;
  /** Flat roofs set the white point. */
  flat: boolean;
  ring: ArrayLike<number>;
}

function median(values: number[]): number {
  const sorted = values.toSorted((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The photo's grey: the median a/b of the flat roofs. */
export function whitePoint(roofs: readonly Roof[]): [a: number, b: number] {
  const labs = roofs
    .filter((r) => r.flat && r.roofColor !== null)
    .map((r) => toOklab(r.roofColor!));
  if (!labs.length) return [0, 0];
  return [median(labs.map((l) => l[1])), median(labs.map((l) => l[2]))];
}

/** Edges keyed by their end points in decimetres, the precision the city file keeps. */
const edgeKey = (ax: number, az: number, bx: number, bz: number) =>
  `${Math.round(ax * 10)},${Math.round(az * 10)},${Math.round(bx * 10)},${Math.round(bz * 10)}`;

/** For each roof, the roofs that share a footprint edge with it (party walls). */
export function partyNeighbours(roofs: readonly Pick<Roof, 'ring'>[]): number[][] {
  const owner = new Map<string, number>();
  for (const [i, { ring }] of roofs.entries()) {
    const n = ring.length / 2;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      owner.set(edgeKey(ring[k * 2]!, ring[k * 2 + 1]!, ring[j * 2]!, ring[j * 2 + 1]!), i);
    }
  }
  return roofs.map(({ ring }, i) => {
    const found = new Set<number>();
    const n = ring.length / 2;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      // The neighbour walks the shared edge the other way round.
      const other = owner.get(
        edgeKey(ring[j * 2]!, ring[j * 2 + 1]!, ring[k * 2]!, ring[k * 2 + 1]!),
      );
      if (other !== undefined && other !== i) found.add(other);
    }
    return [...found];
  });
}

/**
 * Balances and stretches every sampled colour, then sets each pitched roof to the median of
 * itself and the pitched neighbours that look like the same roofing. Changes `roofColor` in place.
 */
export function correctRoofColours(roofs: Roof[]): void {
  const [wa, wb] = whitePoint(roofs);
  const labs = roofs.map(({ roofColor }): Lab | null => {
    if (roofColor === null) return null;
    const [l, a, b] = toOklab(roofColor);
    return [l, (a - wa) * CHROMA_STRETCH, (b - wb) * CHROMA_STRETCH];
  });
  const neighbours = partyNeighbours(roofs);
  for (const [i, roof] of roofs.entries()) {
    const own = labs[i];
    if (!own) continue;
    const alike = roof.flat
      ? [own]
      : [
          own,
          ...neighbours[i]!.flatMap((j) => {
            const lab = labs[j];
            const close =
              lab &&
              !roofs[j]!.flat &&
              Math.hypot(...lab.map((v, k) => v - own[k]!)) < SAME_ROOFING;
            return close ? [lab] : [];
          }),
        ];
    roof.roofColor = fromOklab([0, 1, 2].map((k) => median(alike.map((l) => l[k]!))) as Lab);
  }
}
