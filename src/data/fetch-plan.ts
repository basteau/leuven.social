/**
 * What `bun run data:fetch` asks each service for, and how it checks and merges the answers.
 * Pure: scripts/fetch.ts does the network and files. See src/data/sources.ts for the list.
 */

import type { Bounds } from './city.ts';
import { toLonLat } from './projection.ts';
import { gridBox, lonLatBox, orthoRects } from './sources.ts';
import type {
  GridBox,
  LonLatBox,
  OverpassSource,
  Source,
  WcsSource,
  WfsSource,
  WmtsSource,
} from './sources.ts';

/** A download went wrong in a way retrying the same server won't fix. */
export class SourceError extends Error {
  override name = 'SourceError';
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Splits a box into a grid of equal tiles no wider or taller than `max` degrees. */
export function lonLatTiles(box: LonLatBox, max: number): LonLatBox[] {
  const cols = Math.max(1, Math.ceil(round((box.east - box.west) / max)));
  const rows = Math.max(1, Math.ceil(round((box.north - box.south) / max)));
  const tiles: LonLatBox[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        west: round(box.west + ((box.east - box.west) * c) / cols),
        east: round(box.west + ((box.east - box.west) * (c + 1)) / cols),
        south: round(box.south + ((box.north - box.south) * r) / rows),
        north: round(box.south + ((box.north - box.south) * (r + 1)) / rows),
      });
    }
  }
  return tiles;
}

/** One Overpass request: the source's statements inside a tile, as OpenStreetMap was on `date`. */
export function overpassQuery(source: OverpassSource, tile: LonLatBox, date: string): string {
  const bbox = [tile.south, tile.west, tile.north, tile.east].join(',');
  return `[out:json][timeout:180][date:"${date}"][bbox:${bbox}];(${source.statements});out ${source.out};`;
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  [key: string]: unknown;
}

export interface OverpassResult {
  osm3s?: { timestamp_osm_base?: string };
  remark?: string;
  elements: OsmElement[];
}

/**
 * Parses an Overpass answer. A `remark` means the server gave up part-way (timeout, memory)
 * and the elements are incomplete, so it counts as a failure, not as data.
 */
export function checkOverpass(text: string): OverpassResult {
  const json = parseJson(text, 'Overpass');
  if (typeof json.remark === 'string') throw new SourceError(`Overpass remark: ${json.remark}`);
  if (!Array.isArray(json.elements)) throw new SourceError('Overpass answer has no elements');
  return json as unknown as OverpassResult;
}

const TYPE_ORDER = { node: 0, way: 1, relation: 2 } as const;

/**
 * Tiles overlap where ways cross their edges: keep one copy of each element, in type and id
 * order, so the result doesn't depend on how the area was tiled. No server or time fields,
 * so the same OpenStreetMap gives the same bytes.
 */
export function mergeOverpass(results: readonly OverpassResult[], date: string) {
  const byKey = new Map<string, OsmElement>();
  for (const r of results) for (const e of r.elements) byKey.set(`${e.type}/${e.id}`, e);
  const elements = [...byKey.values()].toSorted(
    (a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.id - b.id,
  );
  return {
    version: 0.6,
    osm3s: {
      timestamp_osm_base: date,
      copyright:
        'The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.',
    },
    elements,
  };
}

/**
 * WFS 2.0 GetFeature for one box, in EPSG:4326 (whose axis order is lat, lon). No paging: the
 * GRB server doesn't keep its sort order from one request to the next, so `startIndex` pages
 * skip and repeat features at their edges. A box that comes back full is split instead.
 */
export function wfsUrl(source: WfsSource, box: LonLatBox) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: source.typeName,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    bbox: `${box.south},${box.west},${box.north},${box.east},urn:ogc:def:crs:EPSG::4326`,
    sortBy: source.sortBy,
    count: String(WFS_LIMIT),
  });
  return `${source.endpoint}?${params}`;
}

export interface Feature {
  type: 'Feature';
  id?: string | number;
  properties: Record<string, unknown>;
  geometry: unknown;
  [key: string]: unknown;
}

export interface WfsPage {
  features: Feature[];
  numberMatched?: number | 'unknown';
}

export function checkWfsPage(text: string): WfsPage {
  const json = parseJson(text, 'WFS');
  if (json.type !== 'FeatureCollection' || !Array.isArray(json.features)) {
    throw new SourceError('WFS answer is not a GeoJSON FeatureCollection');
  }
  return json as unknown as WfsPage;
}

/**
 * The most features asked for at once: answers of 2,500 come back reliably, 5,000 sometimes
 * time out. An answer this long may be cut short, so its box is split (`quarter`).
 */
export const WFS_LIMIT = 2500;

/** The four quarters of a box, for a WFS answer that came back full. */
export function quarter(box: LonLatBox): LonLatBox[] {
  const lon = round((box.west + box.east) / 2);
  const lat = round((box.south + box.north) / 2);
  return [
    { west: box.west, south: box.south, east: lon, north: lat },
    { west: lon, south: box.south, east: box.east, north: lat },
    { west: box.west, south: lat, east: lon, north: box.north },
    { west: lon, south: lat, east: box.east, north: box.north },
  ];
}

/**
 * Joins the answers into one FeatureCollection in `sortBy` order, keeping one copy of a
 * feature that crosses boxes, checks none went missing where the server says how many
 * matched, and drops the server's paging and timestamp fields.
 */
export function mergeWfs(pages: readonly WfsPage[], sortBy: string) {
  const byId = new Map<string, Feature>();
  for (const p of pages) for (const f of p.features) byId.set(String(f.id), f);
  const features = [...byId.values()].toSorted(
    (a, b) =>
      Number(a.properties[sortBy]) - Number(b.properties[sortBy]) ||
      String(a.id).localeCompare(String(b.id)),
  );
  const matched = pages[0]?.numberMatched;
  if (typeof matched === 'number' && matched !== features.length) {
    throw new SourceError(`WFS matched ${matched} features but returned ${features.length}`);
  }
  return { type: 'FeatureCollection', features };
}

/** GeoTIFF tiles no larger than 1650 × 1000 px: the DHMV WCS refuses much more. */
export function gridTiles(box: GridBox, resolution: number, maxW = 1650, maxH = 1000): GridBox[] {
  const tiles: GridBox[] = [];
  for (let y = box.minY; y < box.maxY; y += maxH * resolution) {
    for (let x = box.minX; x < box.maxX; x += maxW * resolution) {
      tiles.push({
        minX: x,
        minY: y,
        maxX: Math.min(box.maxX, x + maxW * resolution),
        maxY: Math.min(box.maxY, y + maxH * resolution),
      });
    }
  }
  return tiles;
}

/** WCS 1.0.0 GetCoverage: a plain GeoTIFF in Lambert 72, one pixel per `resolution` metres. */
export function wcsUrl(source: WcsSource, tile: GridBox): string {
  const params = new URLSearchParams({
    service: 'WCS',
    version: '1.0.0',
    request: 'GetCoverage',
    coverage: source.coverage,
    crs: 'EPSG:31370',
    bbox: [tile.minX, tile.minY, tile.maxX, tile.maxY].join(','),
    width: String((tile.maxX - tile.minX) / source.resolution),
    height: String((tile.maxY - tile.minY) / source.resolution),
    format: 'GeoTIFF',
  });
  return `${source.endpoint}?${params}`;
}

export const wcsFile = (source: WcsSource, tile: GridBox) =>
  `${source.output}/${tile.minX}_${tile.minY}.tif`;

/** Web-mercator tile column and row of a point. */
function mercatorTile(lon: number, lat: number, zoom: number): [number, number] {
  const n = 2 ** zoom;
  const y = (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;
  return [Math.floor(((lon + 180) / 360) * n), Math.floor(y * n)];
}

/** Every tile touching one of the local rectangles, sorted by column then row. */
export function mercatorTiles(rects: readonly Bounds[], zoom: number): [number, number][] {
  const keys = new Set<string>();
  for (const r of rects) {
    const [x0, y0] = mercatorTile(...toLonLat(r.minX, r.minZ), zoom);
    const [x1, y1] = mercatorTile(...toLonLat(r.maxX, r.maxZ), zoom);
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) keys.add(`${x}_${y}`);
    }
  }
  return [...keys]
    .map((k) => k.split('_').map(Number) as [number, number])
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
}

export function wmtsUrl(source: WmtsSource, x: number, y: number): string {
  const params = new URLSearchParams({
    SERVICE: 'WMTS',
    REQUEST: 'GetTile',
    VERSION: '1.0.0',
    LAYER: source.layer,
    STYLE: '',
    FORMAT: 'image/png',
    TILEMATRIXSET: 'GoogleMapsVL',
    TILEMATRIX: String(source.zoom),
    TILEROW: String(y),
    TILECOL: String(x),
  });
  return `${source.endpoint}?${params}`;
}

export const wmtsFile = (source: WmtsSource, x: number, y: number) =>
  `${source.output}/${x}_${y}.png`;

/** The files under data/ a source fills: one merged file, or one per tile. */
export function outputFiles(source: Source): string[] {
  switch (source.kind) {
    case 'overpass':
    case 'wfs':
      return [source.output];
    case 'wcs':
      return gridTiles(gridBox(lonLatBox()), source.resolution).map((t) => wcsFile(source, t));
    case 'wmts':
      return mercatorTiles(orthoRects(), source.zoom).map(([x, y]) => wmtsFile(source, x, y));
  }
}

const startsWith = (bytes: Uint8Array, magic: readonly number[]) =>
  bytes.length > magic.length && magic.every((b, i) => bytes[i] === b);

/** OGC services answer errors with HTTP 200 and an XML body, so check what came back. */
export function isTiff(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]);
}

export function isPng(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function parseJson(text: string, service: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SourceError(`${service} did not answer JSON: ${text.slice(0, 120)}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new SourceError(`${service} answered JSON that is not an object`);
  }
  return json as Record<string, unknown>;
}

/** Lower-case hex SHA-256 of some bytes or text. */
export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the lock file records for one source: enough to tell whether two fetches match. */
export interface LockEntry {
  /** Hash of every request made, so a changed extent or query shows up as a new plan. */
  plan: string;
  files: number;
  bytes: number;
  /** Hash over the sorted list of each file's path and hash. */
  sha256: string;
  /** When these exact bytes were first fetched (ISO date). */
  fetched: string;
}

/** One hash for a set of files, independent of the order they were listed in. */
export async function digestFiles(
  files: readonly { path: string; sha256: string; bytes: number }[],
): Promise<Pick<LockEntry, 'files' | 'bytes' | 'sha256'>> {
  const lines = files
    .map((f) => `${f.sha256}  ${f.path}\n`)
    .toSorted()
    .join('');
  return {
    files: files.length,
    bytes: files.reduce((sum, f) => sum + f.bytes, 0),
    sha256: await sha256(lines),
  };
}
