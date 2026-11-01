/**
 * Map labels come from the data, not from typed-in names and coordinates. `LANDMARKS` (area.ts)
 * only says which places to label, by a stable id; the name and the position are read from the
 * OpenStreetMap element that carries that id, or from the GRB footprint OSM's name is joined to.
 */

type Tags = Record<string, string | undefined>;

/** Which place a label names: a Wikidata id on an OSM element, an OSM element, or a GRB footprint. */
export type LabelRef = { wikidata: string } | { osm: string } | { grb: number };

/** The part of an Overpass element (`out geom` or `out center`) that labels read. */
export interface OsmElement {
  type: string;
  id: number;
  tags?: Tags;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}

/** The city's own name adds nothing on a map of the city: "Stadhuis van Leuven" is the Stadhuis. */
const CITY_SUFFIX = / (van |- )?Leuven$/;

/** A label's text: OSM's short name if it has one, else its name, without the city's name. */
export function labelName(tags: Tags): string | null {
  const name = tags.short_name ?? tags.name;
  return name ? name.replace(CITY_SUFFIX, '') : null;
}

/** Longitude and latitude of an element: a node's own, else the middle of its outline. */
export function elementCentre(e: OsmElement): [lon: number, lat: number] | null {
  if (e.lon !== undefined && e.lat !== undefined) return [e.lon, e.lat];
  if (e.center) return [e.center.lon, e.center.lat];
  if (e.bounds) {
    const b = e.bounds;
    return [(b.minlon + b.maxlon) / 2, (b.minlat + b.maxlat) / 2];
  }
  return null;
}

const extent = (e: OsmElement) =>
  e.bounds ? (e.bounds.maxlat - e.bounds.minlat) * (e.bounds.maxlon - e.bounds.minlon) : 0;

/**
 * The element a label refers to. A Wikidata id can sit on several elements (a square and the
 * streets around it, a building and its parts): the one with the widest outline is the place.
 */
export function findElement(
  ref: { wikidata: string } | { osm: string },
  elements: readonly OsmElement[],
): OsmElement | null {
  const matches =
    'wikidata' in ref
      ? elements.filter((e) => e.tags?.wikidata === ref.wikidata)
      : elements.filter((e) => `${e.type}/${e.id}` === ref.osm);
  return matches.reduce<OsmElement | null>((a, b) => (a && extent(a) >= extent(b) ? a : b), null);
}
