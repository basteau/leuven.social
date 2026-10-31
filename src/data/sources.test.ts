import { expect, test } from 'bun:test';

import { AREA, VIEW_AREA } from './area.ts';
import { toLambert72, toLonLat } from './projection.ts';
import {
  CREDITS,
  DATA_MARGIN,
  ORTHO_MARGIN,
  OSM_DATE,
  PROVIDERS,
  SOURCES,
  gridBox,
  lonLatBox,
  orthoRects,
} from './sources.ts';

test('every source has a unique id, a unique output and a known provider', () => {
  const ids = SOURCES.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every((id) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))).toBe(true);
  const outputs = SOURCES.map((s) => s.output);
  expect(new Set(outputs).size).toBe(outputs.length);
  expect(SOURCES.every((s) => s.provider in PROVIDERS && s.usedBy.length > 0)).toBe(true);
});

test('the HUD credits each organisation once, with a link', () => {
  expect(CREDITS.map((c) => c.label)).toEqual(['© OpenStreetMap', '© Digitaal Vlaanderen']);
  expect(CREDITS.every((c) => c.href.startsWith('https://'))).toBe(true);
});

test('OpenStreetMap is read at a fixed moment', () => {
  expect(new Date(OSM_DATE).toISOString().replace('.000', '')).toBe(OSM_DATE);
});

test('the download box holds the whole area plus its margin, on a 1e-4° grid', () => {
  const box = lonLatBox();
  const [west, north] = toLonLat(VIEW_AREA.minX - DATA_MARGIN, VIEW_AREA.minZ - DATA_MARGIN);
  const [east, south] = toLonLat(VIEW_AREA.maxX + DATA_MARGIN, VIEW_AREA.maxZ + DATA_MARGIN);
  expect(box.west).toBeLessThanOrEqual(west);
  expect(box.east).toBeGreaterThanOrEqual(east);
  expect(box.south).toBeLessThanOrEqual(south);
  expect(box.north).toBeGreaterThanOrEqual(north);
  for (const v of Object.values(box))
    expect(Math.abs(v * 1e4 - Math.round(v * 1e4))).toBeLessThan(1e-6);
  expect(box.east - east).toBeLessThan(1e-4);
});

test('the Lambert 72 grid box holds every edge of the lon/lat box, snapped to the step', () => {
  const box = lonLatBox();
  const grid = gridBox(box, 10);
  for (const lon of [box.west, (box.west + box.east) / 2, box.east]) {
    for (const lat of [box.south, (box.south + box.north) / 2, box.north]) {
      const [x, y] = toLambert72(lon, lat);
      expect(x).toBeGreaterThanOrEqual(grid.minX);
      expect(x).toBeLessThanOrEqual(grid.maxX);
      expect(y).toBeGreaterThanOrEqual(grid.minY);
      expect(y).toBeLessThanOrEqual(grid.maxY);
    }
  }
  expect(Object.values(grid).every((v) => v % 10 === 0)).toBe(true);
});

test('orthophotos cover each rectangle of the area, not the box around them', () => {
  const rects = orthoRects();
  expect(rects).toHaveLength(AREA.length);
  rects.forEach((r, i) => {
    expect(r.minX).toBe(AREA[i]!.minX - ORTHO_MARGIN);
    expect(r.maxZ).toBe(AREA[i]!.maxZ + ORTHO_MARGIN);
  });
});

test.each(['docs/DATA.md', 'data/README.md'])('%s names every source', async (doc) => {
  const text = await (await fetch(new URL(`../../${doc}`, import.meta.url))).text();
  expect(SOURCES.filter((s) => !text.includes(`\`${s.id}\``)).map((s) => s.id)).toEqual([]);
});
