/**
 * Monuments from OpenStreetMap: what each statue, bust, sculpture, column, memorial stone,
 * fountain and pump is, how big, what it's made of and how it lies. Everything here reads tags:
 * OSM's own, and what the build surveyed at each point (tools/build_leuven_data.py):
 *
 * - `_height`: the LiDAR's height of a compact object standing there (DSM − DTM, 2013–15),
 *   plinth included, when nothing taller (a crown, a wall) covers the ground round it;
 * - `_bearing`, `_length`, `_width`: the plinth or basin the GRB maps under it (structures of
 *   type "cultuur-historisch monument"), as the rectangle round it.
 *
 * src/scene/monuments.ts draws each archetype from these numbers alone.
 */

import type { Material, MonumentKind } from './city.ts';

type Tags = Record<string, string | undefined>;

/** Sculptures with a tagged height of at least this (m) are needles, seen across the city. */
export const NEEDLE_HEIGHT = 12;

/**
 * Height as drawn (m): the default when nothing measured it, then the least and the most a
 * measurement may give. The least keeps a monument a few pixels tall at zoom 2; the most keeps
 * a crown the LiDAR took for one from towering over the square.
 */
const HEIGHT: Record<MonumentKind, readonly [number, number, number]> = {
  statue: [4, 2.6, 9],
  bust: [2.4, 1.8, 4],
  group: [4, 2.6, 9],
  sculpture: [3, 1.2, 9],
  column: [6, 1.8, 30],
  stone: [1.4, 0.8, 2.5],
  fountain: [3.2, 1.6, 5],
  pump: [2.6, 2, 5],
  needle: [NEEDLE_HEIGHT, NEEDLE_HEIGHT, 60],
};

/** A plinth or basin the GRB maps is believed up to this size (m); larger is a square's paving. */
const MAX_PLINTH = 20;

const between = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
const positive = (tag: string | undefined) => {
  const x = Number.parseFloat(tag ?? '');
  return x > 0 && x < 60 ? x : 0;
};

/**
 * The plinth or basin a monument of this height stands on when the GRB maps none: across its
 * facing, then along it (m). A pump keeps room in front for its spout.
 */
export function plinthOf(kind: MonumentKind, height: number): [width: number, depth: number] {
  const square = (k: number, lo: number, hi: number): [number, number] => {
    const s = between(k * height, lo, hi);
    return [s, s];
  };
  switch (kind) {
    case 'group':
      return [between(0.7 * height, 2, 6), between(0.45 * height, 1.4, 4)];
    case 'bust':
      return square(0.33, 0.8, 1.4);
    case 'stone':
      return [between(0.7 * height, 0.6, 1.6), 0.4];
    case 'fountain':
      return [4, 4];
    case 'pump':
      return [0.8, 1.3];
    case 'needle':
      return [1.6, 1.6];
    case 'sculpture':
      return square(0.4, 0.8, 3);
    case 'column':
      return square(0.3, 0.8, 6);
    default:
      return square(0.3, 1, 2.5);
  }
}

/** Flush with the ground: nothing stands up to draw. */
const FLUSH_FOUNTAINS = new Set(['splash_pad', 'nozzle', 'floor']);
/** On a wall or in the pavement: nothing stands free. */
const FLAT_MEMORIALS = new Set(['plaque', 'blue_plaque', 'stolperstein', 'stolperschwelle']);
const COLUMNS = new Set(['obelisk', 'column', 'cross']);
const STONES = new Set(['stone', 'stele', 'war_memorial', 'cannon', 'anchor', 'tablet']);
/** What a sculpture is made of when it's a figure: cast or carved, not welded. */
const FIGURATIVE = new Set([
  'bronze',
  'brass',
  'copper',
  'stone',
  'sandstone',
  'marble',
  'limestone',
]);

/** The first of a list of values (`steel;stone`), as OSM spells them. */
const first = (tag: string | undefined) => (tag ?? '').split(';')[0]!.trim().toLowerCase();

/**
 * A name that lists several people (`A;B`, `A en B`): a group. Not `subject`, which on Leuven's
 * artworks is as often a theme ("University and Universality").
 */
const SEVERAL = /;| en | and | & /i;

/**
 * Which archetype an OSM point is, or null for none (a mural, a plaque on a wall, a splash pad).
 * In order: fountains and pumps by what they do; busts, columns and stones by their memorial
 * type; figures (statues, and sculptures cast or carved, or named "Standbeeld") as one or as a
 * group; other sculptures as abstract, a tall one as a needle; any other memorial as a stone.
 */
export function monumentKind(t: Tags): MonumentKind | null {
  if (t.amenity === 'fountain') return FLUSH_FOUNTAINS.has(t.fountain ?? '') ? null : 'fountain';
  if (t.man_made === 'water_well') return 'pump';
  const art = t.tourism === 'artwork' ? (t.artwork_type ?? '') : '';
  const memorial = t.memorial ?? '';
  if (FLAT_MEMORIALS.has(memorial)) return null;
  if (art === 'bust' || memorial === 'bust' || t['memorial:type'] === 'bust') return 'bust';
  if (COLUMNS.has(memorial) || COLUMNS.has(art) || (t.historic ?? '').startsWith('wayside_'))
    return 'column';
  if (STONES.has(memorial)) return 'stone';
  const figure =
    art === 'statue' ||
    memorial === 'statue' ||
    memorial === 'person' ||
    t.historic === 'statue' ||
    (art === 'sculpture' &&
      (FIGURATIVE.has(first(t.material)) || (t.name ?? '').toLowerCase().startsWith('standbeeld')));
  if (figure) {
    return SEVERAL.test(t.name ?? '') ? 'group' : 'statue';
  }
  if (art === 'sculpture') return positive(t.height) >= NEEDLE_HEIGHT ? 'needle' : 'sculpture';
  return t.historic === 'memorial' ? 'stone' : null;
}

const MATERIALS: Record<string, Material> = {
  bronze: 'bronze',
  brass: 'bronze',
  copper: 'bronze',
  gold: 'bronze',
  stone: 'stone',
  sandstone: 'stone',
  limestone: 'stone',
  granite: 'stone',
  bluestone: 'bluestone',
  blue_stone: 'bluestone',
  arduin: 'bluestone',
  hardstone: 'bluestone',
  marble: 'marble',
  steel: 'steel',
  stainless_steel: 'steel',
  metal: 'steel',
  aluminium: 'steel',
  iron: 'steel',
  cast_iron: 'steel',
  weathering_steel: 'rust',
  corten: 'rust',
  concrete: 'concrete',
  wood: 'wood',
  brick: 'brick',
};

/** What each archetype is usually made of in Leuven, when OSM doesn't say. */
const USUAL: Record<MonumentKind, Material> = {
  statue: 'bronze',
  bust: 'bronze',
  group: 'bronze',
  sculpture: 'steel',
  column: 'stone',
  stone: 'stone',
  fountain: 'water',
  pump: 'bluestone',
  needle: 'steel',
};

/**
 * What it's made of: OSM `material` (the first of several). For a figure, the figure's own
 * (`memorial:material`) first, as the monument's may be its plinth's; for a building-like column,
 * `building:material`. A fountain's is what stands in its basin: its sculpture's, else water.
 */
export function materialOf(kind: MonumentKind, t: Tags): Material {
  const figure = kind === 'statue' || kind === 'bust' || kind === 'group';
  const artwork = kind === 'fountain' && t.tourism === 'artwork';
  const tags = figure ? [t['memorial:material'], t.material] : [t.material, t['building:material']];
  for (const tag of kind === 'fountain' && !artwork ? [] : tags) {
    const material = MATERIALS[first(tag)];
    if (material) return material;
  }
  return artwork ? 'bronze' : USUAL[kind];
}

export interface Monument {
  kind: MonumentKind;
  /** Height as drawn, plinth included (m). */
  size: number;
  /** The plinth or basin across (u) and along (v) its facing (m). */
  width: number;
  depth: number;
  material: Material;
  /** The way the GRB's plinth runs, as an OSM bearing (degrees), when it maps one. */
  bearing: string | undefined;
}

/**
 * A monument's archetype, size and material from its tags, or null if it isn't one. Its height
 * is the LiDAR's when the build measured one, else the tagged `height`, else its archetype's (a
 * figure's at least 1.2 times its plinth's length), within the archetype's bounds; a needle's is
 * its tag's. Its plinth is the GRB's when there is
 * one (the long side across its facing), else its archetype's for that height.
 */
export function monumentFromOsm(t: Tags): Monument | null {
  const kind = monumentKind(t);
  if (!kind) return null;
  const [usual, least, most] = HEIGHT[kind];
  const [length, across] = [positive(t['_length']), positive(t['_width'])];
  const mapped = length > 0 && across > 0;
  // Unmeasured, a wayside shrine or cross is a pillar a little taller than a person, not an
  // obelisk, and a figure on a wide plinth stands as tall as the plinth is long.
  const wayside = (t.historic ?? '').startsWith('wayside_');
  const figure = kind === 'statue' || kind === 'group';
  const guess = wayside ? 2.4 : Math.max(usual, figure && mapped ? 1.2 * length : 0);
  const measured = kind === 'needle' ? 0 : positive(t['_height']);
  const size = between(measured || positive(t.height) || guess, least, most);
  const [width, depth] = mapped
    ? [Math.min(length, MAX_PLINTH), Math.min(across, MAX_PLINTH)]
    : plinthOf(kind, size);
  return {
    kind,
    size,
    width,
    depth,
    material: materialOf(kind, t),
    bearing: mapped ? t['_bearing'] : undefined,
  };
}
