/**
 * What a sports pitch is made of and what is painted on it, from its OSM `surface` and `sport`
 * (docs/DATA.md, "Kinds of ground"). Every pitch gets a surface; the ones that are a field of a
 * sport we draw, at a size and shape its lines fit, also get a field: the rectangle its lines are
 * laid out in, measured on the whole outline before the bake cuts it to the map's area.
 */

import type { Bounds } from './city.ts';
import { areaIndex, orientedRect } from './geometry.ts';
import type { OrientedRect } from './geometry.ts';

type Tags = Readonly<Record<string, string | undefined>>;

/** What a pitch is drawn in. Hard is asphalt, concrete and coated courts; gravel is a boules pitch. */
export const PITCH_SURFACES = [
  'grass',
  'turf',
  'clay',
  'tartan',
  'hard',
  'sand',
  'gravel',
] as const;
export type PitchSurface = (typeof PITCH_SURFACES)[number];

/** The sports whose lines are drawn: a running track gets its lanes. */
export const FIELD_SPORTS = ['soccer', 'tennis', 'basketball', 'track'] as const;
export type FieldSport = (typeof FIELD_SPORTS)[number];

/**
 * A field's lines, laid out in a rectangle: its centre, the direction of its long side (radians
 * from +x towards +z, in [0, π)), its length and width (m), and how many courts lie side by side
 * across it (tennis) or how many lanes run round it (a track, whose rectangle is its infield's).
 */
export interface Field {
  sport: FieldSport;
  x: number;
  z: number;
  angle: number;
  length: number;
  width: number;
  count: number;
}

/** OSM `surface` values, by what they look like from above. */
const SURFACE_TAGS: Record<string, PitchSurface> = {
  grass: 'grass',
  artificial_turf: 'turf',
  artificial_grass: 'turf',
  clay: 'clay',
  tartan: 'tartan',
  rubber: 'tartan',
  asphalt: 'hard',
  concrete: 'hard',
  acrylic: 'hard',
  paved: 'hard',
  paving_stones: 'hard',
  wood: 'hard',
  sand: 'sand',
  compacted: 'gravel',
  fine_gravel: 'gravel',
  gravel: 'gravel',
  dirt: 'gravel',
  ground: 'gravel',
  unpaved: 'gravel',
};

/**
 * A sport's usual surface in Leuven, for a pitch that doesn't tag its own: its tennis clubs play
 * on clay (red on the orthophotos), padel and hockey on turf, ball courts on hard ground.
 */
const SPORT_SURFACE: Record<string, PitchSurface> = {
  soccer: 'grass',
  rugby_union: 'grass',
  rugby_league: 'grass',
  american_football: 'grass',
  cricket: 'grass',
  athletics: 'grass',
  field_hockey: 'turf',
  padel: 'turf',
  tennis: 'clay',
  basketball: 'hard',
  volleyball: 'hard',
  handball: 'hard',
  futsal: 'hard',
  multi: 'hard',
  skateboard: 'hard',
  bmx: 'hard',
  roller_skating: 'hard',
  table_tennis: 'hard',
  beachvolleyball: 'sand',
  beach_soccer: 'sand',
  boules: 'gravel',
  petanque: 'gravel',
  bowls: 'gravel',
};

const sports = (tags: Tags) => (tags.sport ?? '').split(';').map((s) => s.trim());

/**
 * What a pitch or track is drawn in: its `surface`, else its first sport's usual one, else a
 * running track's tartan, else grass.
 */
export function pitchSurface(tags: Tags): PitchSurface {
  const tagged = SURFACE_TAGS[tags.surface ?? ''];
  if (tagged) return tagged;
  for (const sport of sports(tags)) if (SPORT_SURFACE[sport]) return SPORT_SURFACE[sport];
  return tags.leisure === 'track' ? 'tartan' : 'grass';
}

/** A tennis court with room round it: 10.97 m wide inside 16 m (Belgian clubs space them so). */
const TENNIS_STRIP = 16;
/** A court's 23.77 m with room to serve and run at both ends. */
const TENNIS_LENGTH = 30;
/** Running lanes are 1.22 m wide; a track has at most 8. */
export const LANE = 1.22;
const MAX_LANES = 8;

/**
 * Which outlines a sport's lines fit: long and wide enough, between the ratios its fields come
 * in, and near a rectangle (its area at least `fill` of its rectangle's). Smaller or odder ones
 * (a 5 m strip of basketball, an L-shaped tennis park) keep their colour without lines.
 */
const FITS: Record<
  Exclude<FieldSport, 'track'>,
  { length: number; width: number; ratio: [number, number] }
> = {
  soccer: { length: 25, width: 14, ratio: [1.2, 2.4] },
  tennis: { length: 28, width: 15, ratio: [0.9, 2.4] },
  basketball: { length: 20, width: 11, ratio: [1.4, 2.4] },
};
const FILL = 0.85;
/** A track's infield: a stadium shape (two straights and two bends) fills about 0.9 of its box. */
const TRACK = { width: 30, ratio: [1.4, 2.6], fill: 0.75 } as const;

const fromRect = (sport: FieldSport, r: OrientedRect, count: number): Field => {
  const angle = Math.atan2(r.uz, r.ux);
  return {
    sport,
    x: r.cx,
    z: r.cz,
    angle: angle < 0 ? angle + Math.PI : angle >= Math.PI ? angle - Math.PI : angle,
    length: r.halfLength * 2,
    width: r.halfWidth * 2,
    count,
  };
};

/** The corners of a field's rectangle, flat [x, z, …]. */
export function fieldCorners({ x, z, angle, length, width }: Field): number[] {
  const [ux, uz] = [Math.cos(angle), Math.sin(angle)];
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].flatMap(([a, b]) => [
    x + (ux * a! * length) / 2 - (uz * b! * width) / 2,
    z + (uz * a! * length) / 2 + (ux * b! * width) / 2,
  ]);
}

/**
 * The field a pitch or track's whole outline holds, or null: a soccer pitch, tennis courts or a
 * basketball court whose outline is near a rectangle of their size and shape, or a running track
 * round an infield (its one hole) wide enough for three lanes or more. A field that reaches out of
 * `area` is left out, as its lines would run off the map.
 */
export function fieldOf(
  tags: Tags,
  polygon: { outer: ArrayLike<number>; holes: readonly ArrayLike<number>[] },
  area: readonly Bounds[],
): Field | null {
  const field = layout(tags, polygon);
  if (!field) return null;
  const corners = fieldCorners(field);
  for (let i = 0; i < corners.length; i += 2) {
    if (areaIndex(area, corners[i]!, corners[i + 1]!) < 0) return null;
  }
  return field;
}

function layout(
  tags: Tags,
  { outer, holes }: { outer: ArrayLike<number>; holes: readonly ArrayLike<number>[] },
): Field | null {
  if (tags.leisure === 'track') {
    if (holes.length !== 1) return null;
    const inner = orientedRect(holes[0]!);
    const ratio = inner.halfLength / inner.halfWidth;
    if (inner.halfWidth * 2 < TRACK.width || ratio < TRACK.ratio[0] || ratio > TRACK.ratio[1])
      return null;
    if (inner.fill < TRACK.fill) return null;
    const lanes = Math.floor((orientedRect(outer).halfWidth - inner.halfWidth) / LANE);
    return lanes >= 3 ? fromRect('track', inner, Math.min(lanes, MAX_LANES)) : null;
  }
  const sport = sports(tags).find((s): s is Exclude<FieldSport, 'track'> => s in FITS);
  if (!sport || holes.length) return null;
  const rect = orientedRect(outer);
  const fit = FITS[sport];
  const [length, width] = [rect.halfLength * 2, rect.halfWidth * 2];
  const ratio = length / width;
  if (length < fit.length || width < fit.width || rect.fill < FILL) return null;
  if (ratio < fit.ratio[0] || ratio > fit.ratio[1]) return null;
  if (sport !== 'tennis') return fromRect(sport, rect, 1);
  // Courts lie side by side, whichever way round fits more of them: three across a park 51 m
  // long and 37 m deep, two along one 37 by 36.
  const along = Math.floor(width / TENNIS_STRIP);
  const across = width >= TENNIS_LENGTH ? Math.floor(length / TENNIS_STRIP) : 0;
  if (along >= across) return fromRect(sport, rect, Math.max(1, along));
  const turned = { ...rect, ux: -rect.uz, uz: rect.ux, halfLength: rect.halfWidth };
  return fromRect(sport, { ...turned, halfWidth: rect.halfLength }, across);
}
