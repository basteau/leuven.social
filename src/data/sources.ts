/**
 * Every outside source the city is built from: what it is, where it comes from, under which
 * licence, and where its download lands in data/. `bun run data:fetch` (scripts/fetch.ts)
 * downloads exactly this list, docs/DATA.md and data/README.md describe it, and the HUD's
 * credits come from its providers (src/data/providers.ts). New data comes in here, never by hand (docs/DATA.md).
 *
 * Extents are not written down: they follow AREA (src/data/area.ts) plus a margin, so growing
 * the map grows every download with it.
 */

import { AREA, VIEW_AREA } from './area.ts';
import type { Bounds } from './city.ts';
import type { ProviderId } from './providers.ts';
import { toLambert72, toLonLat } from './projection.ts';

interface Common {
  /** Short, stable, kebab-case: the lock file is keyed by it. */
  id: string;
  provider: ProviderId;
  title: string;
  /** Path under data/: a file for merged downloads, a directory for tiles. */
  output: string;
  /** What reads it: keeps the list honest about why each download exists. */
  usedBy: string;
}

/**
 * Overpass QL statements, run against the bounding box of a tile (a global `[bbox]`) as the
 * OpenStreetMap of `OSM_DATE`. Tiles are merged, deduplicated and sorted by type and id.
 */
export interface OverpassSource extends Common {
  kind: 'overpass';
  statements: string;
  /**
   * Overpass `out` mode: `tags geom` for tags and geometry, `geom` to also keep relation
   * members (and their geometry), `tags center` for one point per element.
   */
  out: 'tags geom' | 'geom' | 'tags center';
  /** Largest tile side in degrees: dense layers need smaller requests. */
  tile: number;
}

/** A WFS 2.0 layer in GeoJSON, paged by `startIndex` in a stable `sortBy` order. */
export interface WfsSource extends Common {
  kind: 'wfs';
  endpoint: string;
  typeName: string;
  sortBy: string;
}

/** A WCS 1.0 coverage, cut into GeoTIFF tiles on the Lambert 72 grid. */
export interface WcsSource extends Common {
  kind: 'wcs';
  endpoint: string;
  coverage: string;
  /** Metres per pixel. */
  resolution: number;
}

/** WMTS tiles in the GoogleMapsVL (web mercator) matrix set, at one zoom level. */
export interface WmtsSource extends Common {
  kind: 'wmts';
  endpoint: string;
  layer: string;
  zoom: number;
}

export type Source = OverpassSource | WfsSource | WcsSource | WmtsSource;

/**
 * The moment of OpenStreetMap to read. Overpass answers from its history ("attic") for this
 * date, so a fetch next year returns what we built from. Move it forward to pick up new edits.
 */
export const OSM_DATE = '2026-10-31T16:30:00Z';

/** Tried in turn: overpass-api.de keeps the full history; the mirrors answer when it is busy. */
export const OVERPASS_ENDPOINTS: readonly string[] = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** How far past AREA every download reaches, in metres, so edges and border trees are whole. */
export const DATA_MARGIN = 100;
/** Orthophoto tiles hug each rectangle of AREA more closely: there are a thousand of them. */
export const ORTHO_MARGIN = 40;

const OVERPASS_TILE = 0.05;
const GRB_WFS = 'https://geo.api.vlaanderen.be/GRB/wfs';
const DHMV_WCS = 'https://geo.api.vlaanderen.be/DHMV/wcs';

const grb = (layer: string, title: string, usedBy: string): WfsSource => ({
  id: `grb-${layer.toLowerCase()}`,
  provider: 'grb',
  kind: 'wfs',
  title,
  endpoint: GRB_WFS,
  typeName: `GRB:${layer}`,
  sortBy: 'OIDN',
  output: `grb/grb_${layer}.geojson`,
  usedBy,
});

export const SOURCES: readonly Source[] = [
  {
    id: 'osm-buildings',
    provider: 'osm',
    kind: 'overpass',
    title: 'Buildings and building parts, for their tags (name, roof shape, levels, use)',
    statements: 'way["building"]; relation["building"]; way["building:part"];',
    out: 'tags geom',
    tile: 0.025,
    output: 'osm/buildings.json',
    usedBy: 'tools/build_leuven_data.py: tags joined onto GRB footprints',
  },
  {
    id: 'osm-ring',
    provider: 'osm',
    kind: 'overpass',
    title: 'The R23 ring road',
    statements: 'way["ref"="R23"];',
    out: 'tags geom',
    tile: OVERPASS_TILE,
    output: 'osm/ring_r23.json',
    usedBy: 'tools/build_leuven_data.py: the core tier is what lies inside the ring',
  },
  {
    id: 'osm-roads',
    provider: 'osm',
    kind: 'overpass',
    title: 'Every highway way: streets, footways, paths, cycleways, steps',
    statements: 'way["highway"];',
    out: 'tags geom',
    tile: OVERPASS_TILE,
    output: 'osm/roads.json',
    usedBy:
      'bake: paths, pedestrian areas and street names; tools/build_road_zones.py: road surfaces, lanes and crossings',
  },
  {
    id: 'osm-areas',
    provider: 'osm',
    kind: 'overpass',
    title: 'Land use and cover, water, railways, car parks, pitches, squares and street areas',
    // Ways and multipolygon relations alike: a car park, pitch or square drawn as a relation
    // is as much one as a way. Regexes rather than exact values, as in osm-points.
    statements: [
      'way["waterway"]; wr["natural"~"^(water|wood|scrub|heath|grassland|wetland)$"];',
      'wr["landcover"~"^(grass|trees|scrub)$"];',
      'wr["leisure"~"^(park|garden|pitch|playground|sports_centre|schoolyard|track|dog_park)$"];',
      'wr["landuse"]; way["railway"]; wr["place"~"^square$"]; wr["area:highway"];',
      'wr["amenity"~"^(parking|school|university|college|kindergarten|hospital|grave_yard)$"];',
    ].join(' '),
    // `geom`, not `tags geom`: that leaves out a relation's members, and so all its rings.
    out: 'geom',
    tile: OVERPASS_TILE,
    output: 'osm/areas.json',
    usedBy:
      'bake: green, woods, pitches, car parks, water, plazas and their names, railway tracks and railway land; scripts/audit-areas.ts',
  },
  {
    id: 'osm-points',
    provider: 'osm',
    kind: 'overpass',
    title: 'Mapped trees and points of interest',
    statements: [
      // A regex, not ="tree": read from history, Overpass looks an exact value of so common a
      // tag up worldwide before cutting it to the box, and runs out of memory.
      'node["natural"~"^tree$"];',
      'nwr["amenity"~"pub|bar|cafe|restaurant|fast_food|university|library|theatre|cinema|bicycle_parking|bicycle_rental|fountain|bench|place_of_worship|townhall"];',
      'nwr["tourism"]; nwr["historic"]; nwr["man_made"~"tower|statue"];',
      'node["highway"~"street_lamp|traffic_signals|bus_stop"];',
    ].join(' '),
    out: 'tags center',
    tile: 0.025,
    output: 'osm/points.json',
    usedBy: 'bake: mapped trees, street furniture and shop fronts',
  },
  {
    id: 'osm-furniture-ways',
    provider: 'osm',
    kind: 'overpass',
    title: 'Benches and bike parkings mapped as lines or areas, with their geometry',
    // osm-points keeps one centre per way; this gives the same ways their shape, for the way
    // they run and how long they are.
    statements: 'way["amenity"~"^(bench|bicycle_parking)$"];',
    out: 'tags geom',
    tile: OVERPASS_TILE,
    output: 'osm/furniture_ways.json',
    usedBy: 'tools/build_leuven_data.py: the axis and length of benches and racks drawn as ways',
  },
  {
    id: 'osm-rail-platforms',
    provider: 'osm',
    kind: 'overpass',
    title: 'Railway platforms, with their multipolygon members',
    statements: [
      'relation["railway"="platform"]; way["railway"="platform"];',
      'relation["public_transport"="platform"]["train"="yes"]; way["public_transport"="platform"]["train"="yes"];',
    ].join(' '),
    out: 'geom',
    tile: OVERPASS_TILE,
    output: 'osm/rail_platforms.json',
    usedBy: 'bake: station platforms',
  },
  grb('GBG', 'Building footprints, with courtyards', 'tools/build_leuven_data.py: every building'),
  grb(
    'GBA',
    'Building annexes',
    'tools/build_leuven_data.py: keeps LiDAR trees off sheds; bake: platform roofs',
  ),
  grb('WBN', 'Road surfaces', 'bake: roads; tools/build_road_zones.py: carriageways'),
  grb(
    'WGO',
    'Road subdivision lines: kerbs, cycle and pedestrian zones',
    'tools/build_road_zones.py: carriageways, pavements and cycle tracks',
  ),
  grb('WTZ', 'Watercourses', 'bake: water'),
  grb(
    'KNW',
    'Structures: bridges, tanks, silos',
    'tools/build_leuven_data.py: bridge parapets, and tanks with their LiDAR height',
  ),
  ...(['DTM', 'DSM'] as const).map((model): WcsSource => ({
    id: `dhmv-${model.toLowerCase()}`,
    provider: 'dhmv',
    kind: 'wcs',
    title:
      model === 'DTM'
        ? 'Terrain (bare earth), 1 m, m TAW (LiDAR 2013–2015)'
        : 'Surface with roofs and trees, 1 m, m TAW (LiDAR 2013–2015)',
    endpoint: DHMV_WCS,
    coverage: `DHMVII_${model}_1m`,
    resolution: 1,
    output: `elevation/${model}`,
    usedBy: 'tools/build_leuven_data.py: heights, roof survey and LiDAR trees',
  })),
  {
    id: 'ortho',
    provider: 'ortho',
    kind: 'wmts',
    title: 'Most recent winter orthophoto mosaic, z18 (~0.37 m/px)',
    endpoint: 'https://geo.api.vlaanderen.be/OMWRGBMRVL/wmts',
    layer: 'omwrgbmrvl',
    zoom: 18,
    output: 'ortho/z18',
    usedBy: 'tools/build_leuven_data.py: roof colours (no imagery ships)',
  },
];

/** Degrees, west/south/east/north. */
export interface LonLatBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Lambert 72 metres. */
export interface GridBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const floorTo = (v: number, step: number) => Math.floor(v / step) * step;
const ceilTo = (v: number, step: number) => Math.ceil(v / step) * step;
/** Rounds away from floating-point dust before snapping, so 4.7 doesn't become 4.6999. */
const clean = (v: number) => Math.round(v * 1e9) / 1e9;

/** The lon/lat box around a local rectangle plus a margin, snapped outwards to 1e-4°. */
export function lonLatBox(rect: Bounds = VIEW_AREA, margin = DATA_MARGIN): LonLatBox {
  const [west, north] = toLonLat(rect.minX - margin, rect.minZ - margin);
  const [east, south] = toLonLat(rect.maxX + margin, rect.maxZ + margin);
  const step = 1e-4;
  return {
    west: clean(floorTo(west, step)),
    south: clean(floorTo(south, step)),
    east: clean(ceilTo(east, step)),
    north: clean(ceilTo(north, step)),
  };
}

/**
 * The Lambert 72 grid box that holds a lon/lat box, snapped outwards to `step` metres. The
 * edges are sampled, not just the corners: meridians lean in Lambert 72.
 */
export function gridBox(box: LonLatBox, step = 10): GridBox {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= 8; i++) {
    const lon = box.west + ((box.east - box.west) * i) / 8;
    const lat = box.south + ((box.north - box.south) * i) / 8;
    for (const [x, y] of [
      toLambert72(lon, box.south),
      toLambert72(lon, box.north),
      toLambert72(box.west, lat),
      toLambert72(box.east, lat),
    ]) {
      xs.push(x);
      ys.push(y);
    }
  }
  return {
    minX: floorTo(Math.min(...xs), step),
    minY: floorTo(Math.min(...ys), step),
    maxX: ceilTo(Math.max(...xs), step),
    maxY: ceilTo(Math.max(...ys), step),
  };
}

/** The rectangles orthophoto tiles must cover: each of AREA's, plus ORTHO_MARGIN. */
export const orthoRects = (): Bounds[] =>
  AREA.map((r) => ({
    minX: r.minX - ORTHO_MARGIN,
    minZ: r.minZ - ORTHO_MARGIN,
    maxX: r.maxX + ORTHO_MARGIN,
    maxZ: r.maxZ + ORTHO_MARGIN,
  }));
