/**
 * Shop name boards, for walk mode: each shop front's name, painted on a board over its window or
 * on its awning's valance (src/scene/plates.ts draws them with the plates). The bake chooses the
 * name and places the board on its front (`placeBoards`); walk.bin stores them (src/data/plates.ts).
 */

import type { ShopFront } from './city.ts';
import type { ShopKind } from './shop-kinds.ts';
import { MIN_ROOM, awningRoom, frontPoint } from './shops.ts';

type Tags = Record<string, string | undefined>;

/** A name longer than this (characters) is cut, with an ellipsis, so it fits a front. */
export const MAX_NAME = 22;
export const ELLIPSIS = '…';

/**
 * What a board can show: Latin letters (with their accents), figures, spaces and the punctuation
 * shop names use. The atlas draws only these; anything else (Chinese, Greek, Arabic, emoji) is
 * left out of a name rather than drawn as an empty box.
 */
const SHOWN = /[\p{Script=Latin}0-9 &'’.,\-–!?:/+()@#%*"“”·]/u;
const READABLE = /[\p{Script=Latin}0-9]/u;
/** Spaces and joiners left at either end once letters are dropped. */
const LOOSE_ENDS = /^[\s\-–:,/·|]+|[\s\-–:,/·|]+$/gu;

/** A name with only what a board can show, or null when no letter or figure is left. */
export function latinOnly(name: string): string | null {
  const kept = [...name.normalize('NFC').replace(/\s+/gu, ' ')]
    .filter((ch) => SHOWN.test(ch))
    .join('')
    .replace(/ {2,}/gu, ' ')
    .replace(LOOSE_ENDS, '');
  return READABLE.test(kept) ? kept : null;
}

/**
 * A name cut to `max` characters, the last an ellipsis: at a space when one falls in the second
 * half, so whole words stay whole ("Brasserie De Vrijheid…").
 */
export function cutName(name: string, max = MAX_NAME): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  let kept = chars.slice(0, max - 1);
  const space = kept.lastIndexOf(' ');
  if (chars[max - 1] !== ' ' && space >= max / 2) kept = kept.slice(0, space);
  return `${kept.join('').replace(LOOSE_ENDS, '')}${ELLIPSIS}`;
}

/**
 * The name a shop's board shows: its `brand`, as the fascia of a chain says, else its `name`,
 * whichever has something a board can show, cut to MAX_NAME. Null for none.
 */
export function boardName(tags: Tags): string | null {
  for (const key of ['brand', 'name']) {
    const value = tags[key]?.trim();
    const shown = value ? latinOnly(value) : null;
    if (shown) return cutName(shown);
  }
  return null;
}

/** A shop's name board, on the wall of its front. */
export interface Board {
  /** The middle of its front on the wall, a few centimetres proud of it (`PROUD`). */
  x: number;
  z: number;
  /** Which way its wall faces (radians from +x towards +z). */
  angle: number;
  /** How wide its front is (m): its awning's span, which the board fills. */
  width: number;
  kind: ShopKind;
  name: string;
}

export interface PlacedBoards {
  boards: Board[];
  skipped: Record<string, number>;
}

const dm = (v: number) => Math.round(v * 10) / 10;

/**
 * A board for each front whose shop (its OSM `tags`) has a name, centred on it and as wide as its awning (`awningRoom`),
 * `proud` metres off its wall. A front too narrow for an awning gets none. Its building's ring
 * and the fronts' places are rounded as city.bin keeps them, so the board lines up with the
 * awning the browser draws.
 */
export function placeBoards(
  fronts: readonly ShopFront[],
  rings: readonly ArrayLike<number>[],
  tags: ReadonlyMap<ShopFront, Tags>,
  proud: number,
): PlacedBoards {
  const boards: Board[] = [];
  const skipped: Record<string, number> = {};
  const miss = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  for (const front of fronts) {
    const own = tags.get(front) ?? {};
    const text = boardName(own);
    if (!text) {
      miss(own.brand?.trim() || own.name?.trim() ? 'not in Latin letters' : 'no name');
      continue;
    }
    const along = dm(front.along);
    const p = frontPoint(rings[front.building]!, { edge: front.edge, along });
    const others = fronts
      .filter((o) => o.building === front.building && o.edge === front.edge && o !== front)
      .map((o) => dm(o.along));
    const room = awningRoom(along, p.length, others);
    if (room <= MIN_ROOM) {
      miss('too narrow');
      continue;
    }
    boards.push({
      x: p.x + p.nx * proud,
      z: p.z + p.nz * proud,
      angle: Math.atan2(p.nz, p.nx),
      width: room * 2,
      kind: front.kind,
      name: text,
    });
  }
  return { boards, skipped };
}
