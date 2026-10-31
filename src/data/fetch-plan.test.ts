import { expect, test } from 'bun:test';

import {
  SourceError,
  checkOverpass,
  checkWfsPage,
  checkWikidata,
  digestFiles,
  gridTiles,
  isPng,
  isTiff,
  lonLatTiles,
  mercatorTiles,
  mergeOverpass,
  mergeWfs,
  mergeWikidata,
  outputFiles,
  overpassQuery,
  quarter,
  sha256,
  wcsFile,
  wcsUrl,
  wfsUrl,
  wikidataUrls,
  wmtsFile,
  wmtsUrl,
} from './fetch-plan.ts';
import type { Feature, OsmElement } from './fetch-plan.ts';
import { toLocal } from './projection.ts';
import type {
  OverpassSource,
  Source,
  WcsSource,
  WfsSource,
  WikidataSource,
  WmtsSource,
} from './sources.ts';
import { SOURCES } from './sources.ts';

const box = { west: 4.6, south: 50.8, east: 4.7, north: 50.85 };
const overpass: OverpassSource = {
  id: 'osm-test',
  provider: 'osm',
  kind: 'overpass',
  title: 'Test',
  statements: 'way["highway"];',
  out: 'tags geom',
  tile: 0.05,
  output: 'osm/test.json',
  usedBy: 'tests',
};
const wfs: WfsSource = {
  id: 'grb-test',
  provider: 'grb',
  kind: 'wfs',
  title: 'Test',
  endpoint: 'https://example.test/wfs',
  typeName: 'GRB:GBG',
  sortBy: 'OIDN',
  output: 'grb/test.geojson',
  usedBy: 'tests',
};
const wcs: WcsSource = {
  id: 'dhmv-test',
  provider: 'dhmv',
  kind: 'wcs',
  title: 'Test',
  endpoint: 'https://example.test/wcs',
  coverage: 'DHMVII_DTM_1m',
  resolution: 1,
  output: 'elevation/DTM',
  usedBy: 'tests',
};
const wmts: WmtsSource = {
  id: 'ortho-test',
  provider: 'ortho',
  kind: 'wmts',
  title: 'Test',
  endpoint: 'https://example.test/wmts',
  layer: 'omwrgbmrvl',
  zoom: 17,
  output: 'ortho/z17',
  usedBy: 'tests',
};

const way = (id: number): OsmElement => ({ type: 'way', id, tags: { highway: 'path' } });
const magic = (...b: number[]) => new Uint8Array([...b, 0, 0]);
const filesOf = (kind: Source['kind']) => outputFiles(SOURCES.find((s) => s.kind === kind)!);

test('lonLatTiles splits a box into equal tiles no larger than asked', () => {
  const tiles = lonLatTiles(box, 0.03);
  expect(tiles).toHaveLength(4 * 2);
  for (const t of tiles) {
    expect(t.east - t.west).toBeLessThanOrEqual(0.03);
    expect(t.north - t.south).toBeLessThanOrEqual(0.03);
  }
  expect(Math.min(...tiles.map((t) => t.west))).toBe(box.west);
  expect(Math.max(...tiles.map((t) => t.north))).toBe(box.north);
  expect(lonLatTiles(box, 1)).toEqual([box]);
});

test('overpassQuery reads the tile at the pinned date, south-west-north-east', () => {
  expect(overpassQuery(overpass, box, '2026-10-31T16:30:00Z')).toBe(
    '[out:json][timeout:180][date:"2026-10-31T16:30:00Z"][bbox:50.8,4.6,50.85,4.7];(way["highway"];);out tags geom;',
  );
});

test('checkOverpass refuses partial answers, non-JSON and missing elements', () => {
  expect(checkOverpass('{"elements":[]}').elements).toEqual([]);
  expect(() => checkOverpass('{"elements":[],"remark":"runtime error: timeout"}')).toThrow(
    SourceError,
  );
  expect(() => checkOverpass('<html>busy</html>')).toThrow('did not answer JSON');
  expect(() => checkOverpass('[]')).toThrow('not an object');
  expect(() => checkOverpass('{}')).toThrow('no elements');
});

test('mergeOverpass keeps one of each element, in type and id order, whatever the tiling', () => {
  const node: OsmElement = { type: 'node', id: 9, lat: 50, lon: 4 };
  const a = { elements: [way(3), way(1)] };
  const b = { elements: [way(1), node, { type: 'relation' as const, id: 2 }] };
  const merged = mergeOverpass([a, b], 'D');
  expect(merged.elements.map((e) => `${e.type}/${e.id}`)).toEqual([
    'node/9',
    'way/1',
    'way/3',
    'relation/2',
  ]);
  expect(JSON.stringify(mergeOverpass([b, a], 'D'))).toBe(JSON.stringify(merged));
  expect(merged.osm3s.timestamp_osm_base).toBe('D');
});

test('wfsUrl asks for one box, sorted, with the bbox in lat-lon order', () => {
  const url = new URL(wfsUrl(wfs, box));
  expect(url.origin + url.pathname).toBe('https://example.test/wfs');
  const p = url.searchParams;
  expect(p.get('typeNames')).toBe('GRB:GBG');
  expect(p.get('bbox')).toBe('50.8,4.6,50.85,4.7,urn:ogc:def:crs:EPSG::4326');
  expect(p.get('sortBy')).toBe('OIDN');
  expect(p.get('count')).toBe('2500');
  expect(p.has('startIndex')).toBe(false);
});

test('quarter splits a box into four that cover it exactly', () => {
  const parts = quarter(box);
  expect(parts).toHaveLength(4);
  expect(parts[0]).toEqual({ west: 4.6, south: 50.8, east: 4.65, north: 50.825 });
  expect(parts[3]).toEqual({ west: 4.65, south: 50.825, east: 4.7, north: 50.85 });
});

const feature = (id: number, oidn: number): Feature => ({
  type: 'Feature',
  id: `GBG.${id}`,
  properties: { OIDN: oidn },
  geometry: null,
});

test('checkWfsPage wants a FeatureCollection', () => {
  expect(checkWfsPage('{"type":"FeatureCollection","features":[]}').features).toEqual([]);
  expect(() => checkWfsPage('{"type":"Feature"}')).toThrow('FeatureCollection');
  expect(() => checkWfsPage('<ows:ExceptionReport/>')).toThrow(SourceError);
});

test('mergeWfs joins pages in sortBy order and notices lost features', () => {
  const pages = [
    { numberMatched: 3, features: [feature(1, 30), feature(2, 10)] },
    { features: [feature(2, 10), feature(3, 20)] },
  ];
  const merged = mergeWfs(pages, 'OIDN');
  expect(merged.features.map((f) => f.properties.OIDN)).toEqual([10, 20, 30]);
  expect(Object.keys(merged)).toEqual(['type', 'features']);
  expect(() => mergeWfs([{ numberMatched: 5, features: [feature(1, 1)] }], 'OIDN')).toThrow(
    'matched 5',
  );
  const ties = mergeWfs([{ features: [feature(2, 1), feature(1, 1)] }], 'OIDN');
  expect(ties.features.map((f) => f.id)).toEqual(['GBG.1', 'GBG.2']);
});

test('gridTiles cuts a grid box into tiles the WCS accepts', () => {
  const tiles = gridTiles({ minX: 0, minY: 0, maxX: 3000, maxY: 2500 }, 1);
  expect(tiles).toHaveLength(2 * 3);
  expect(tiles[0]).toEqual({ minX: 0, minY: 0, maxX: 1650, maxY: 1000 });
  expect(tiles.at(-1)).toEqual({ minX: 1650, minY: 2000, maxX: 3000, maxY: 2500 });
  expect(gridTiles({ minX: 0, minY: 0, maxX: 4000, maxY: 1000 }, 2)).toHaveLength(2);
});

test('wcsUrl asks for a GeoTIFF at the source resolution, named by its corner', () => {
  const tile = { minX: 171800, minY: 172230, maxX: 173450, maxY: 173230 };
  const p = new URL(wcsUrl(wcs, tile)).searchParams;
  expect(p.get('coverage')).toBe('DHMVII_DTM_1m');
  expect(p.get('bbox')).toBe('171800,172230,173450,173230');
  expect([p.get('width'), p.get('height')]).toEqual(['1650', '1000']);
  expect(p.get('crs')).toBe('EPSG:31370');
  expect(wcsFile(wcs, tile)).toBe('elevation/DTM/171800_172230.tif');
});

test('mercatorTiles finds the Grote Markt tile and lists each tile once, in order', () => {
  const [x, z] = toLocal(4.70139, 50.87917);
  const one = { minX: x, minZ: z, maxX: x, maxZ: z };
  expect(mercatorTiles([one], 17)).toEqual([[67247, 43949]]);
  const tiles = mercatorTiles([one, { ...one, maxX: x + 400, maxZ: z + 400 }], 17);
  expect(new Set(tiles.map(String)).size).toBe(tiles.length);
  expect(tiles.map(String)).toEqual(
    tiles.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]).map(String),
  );
  expect(tiles.length).toBeGreaterThan(1);
});

test('wmtsUrl names the tile by column and row', () => {
  const p = new URL(wmtsUrl(wmts, 67247, 43949)).searchParams;
  expect([p.get('LAYER'), p.get('TILEMATRIX'), p.get('TILECOL'), p.get('TILEROW')]).toEqual([
    'omwrgbmrvl',
    '17',
    '67247',
    '43949',
  ]);
  expect(wmtsFile(wmts, 67247, 43949)).toBe('ortho/z17/67247_43949.png');
});

test('isTiff and isPng look at the magic bytes, not the extension', () => {
  expect(isTiff(magic(0x49, 0x49, 0x2a, 0x00))).toBe(true);
  expect(isTiff(magic(0x4d, 0x4d, 0x00, 0x2a))).toBe(true);
  expect(isTiff(new TextEncoder().encode('<?xml version="1.0"?>'))).toBe(false);
  expect(isPng(magic(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(true);
  expect(isPng(magic(0x89, 0x50))).toBe(false);
});

test('sha256 and digestFiles hash content, not listing order', async () => {
  expect(await sha256('abc')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  const a = { path: 'a', sha256: '1', bytes: 2 };
  const b = { path: 'b', sha256: '2', bytes: 3 };
  const one = await digestFiles([a, b]);
  expect(one).toEqual(await digestFiles([b, a]));
  expect(one.files).toBe(2);
  expect(one.bytes).toBe(5);
  expect(one.sha256).not.toBe((await digestFiles([a])).sha256);
});

test('outputFiles lists one file for merged sources and one per tile otherwise', () => {
  expect(filesOf('overpass')).toHaveLength(1);
  expect(filesOf('wfs')).toHaveLength(1);
  expect(filesOf('wikidata')).toEqual(['wikidata/labels.json']);
  expect(filesOf('wcs').every((f) => /^elevation\/DTM\/\d+_\d+\.tif$/.test(f))).toBe(true);
  expect(filesOf('wmts').length).toBeGreaterThan(100);
});

const wikidata: WikidataSource = {
  id: 'wikidata-test',
  provider: 'wikidata',
  kind: 'wikidata',
  title: 'Test',
  endpoint: 'https://example.test/w/api.php',
  items: Array.from({ length: 60 }, (_, i) => `Q${i + 1}`),
  output: 'wikidata/test.json',
  usedBy: 'tests',
};
const coord = (latitude: number, longitude: number, rank = 'normal') => ({
  rank,
  mainsnak: { datavalue: { value: { latitude, longitude } } },
});

test('wikidataUrls asks for the claims of at most 50 items at a time', () => {
  const urls = wikidataUrls(wikidata);
  expect(urls).toHaveLength(2);
  const p = new URL(urls[1]!).searchParams;
  expect(p.get('action')).toBe('wbgetentities');
  expect(p.get('ids')).toBe('Q51|Q52|Q53|Q54|Q55|Q56|Q57|Q58|Q59|Q60');
  expect(p.get('props')).toBe('claims');
});

test('checkWikidata refuses API errors and answers without entities', () => {
  expect(checkWikidata('{"entities":{}}').entities).toEqual({});
  expect(() => checkWikidata('{"error":{"code":"no-such-entity"}}')).toThrow('no-such-entity');
  expect(() => checkWikidata('{"success":1}')).toThrow('no entities');
});

test('mergeWikidata keeps only coordinates, preferring the preferred statement', () => {
  const merged = mergeWikidata(
    [
      { entities: { Q2: { claims: { P625: [coord(1, 2), coord(3, 4, 'preferred')] } } } },
      { entities: { Q1: { claims: { P625: [coord(5, 6)], P31: [] } } } },
    ],
    ['Q2', 'Q1'],
  );
  expect(merged).toEqual({ Q1: { lon: 6, lat: 5 }, Q2: { lon: 4, lat: 3 } });
  expect(Object.keys(merged)).toEqual(['Q1', 'Q2']);
  expect(() => mergeWikidata([{ entities: { Q3: { missing: '' } } }], ['Q3'])).toThrow(
    'Q3 has no coordinates',
  );
});
