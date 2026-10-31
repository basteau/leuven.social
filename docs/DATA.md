# City data

The app loads a single file, `public/data/city.bin`, which is about 500 KB gzipped for the whole R23 ring plus Heverlee. It's committed, so a fresh clone runs without the raw data.

## Pipeline

```
Flemish GRB footprints  ─┐
DHMV II LiDAR (DTM/DSM) ─┼─ tools/build_leuven_data.py ─▶ data/derived/ ─▶ bun run bake ─▶ public/data/city.bin
OpenStreetMap (Overpass) ┘        (Python, via uv)       (GeoJSON, JSON)   (scripts/bake.ts)
```

1. **Raw downloads**, about 230 MB, gitignored. [data/README.md](../data/README.md) lists every source, licence and the exact queries. [research/leuven-data-sources.md](../research/leuven-data-sources.md) has the endpoints and gotchas.
2. **`tools/build_leuven_data.py`** joins GRB footprints with LiDAR heights (DSM − DTM, p90), adds OSM tags and assigns a detail tier.
3. **`bun run bake`** keeps what lies in `AREA` (`src/data/area.ts`), projects it to local metres, simplifies it and writes the binary `LVN1` format (`src/data/format.ts`).
   - Buildings are kept whole when every corner is inside the area; ground polygons are clipped to it.
   - Footprint vertices within 0.25 m (core) or 0.5 m (fringe) of the line through their neighbours are dropped; hero footprints keep every vertex, since landmark models are fitted to them. Ground polygons lose vertices within 0.3 m, and patches of green under 25 m² go.

## Coordinates

| Axis   | Meaning                       |
| ------ | ----------------------------- |
| origin | Grote Markt, metres           |
| x      | east                          |
| z      | south (three.js: north is −z) |
| y      | up                            |

`src/data/projection.ts` converts to and from WGS84.

## The area

`AREA` is a few abutting, non-overlapping rectangles, so the diorama can follow the city instead of a single box: today the R23 ring with the station, and a band through Heverlee from Arenbergpark and its castle to the Abdij van Park. The slab's earth sides hang from the outline of their union, and the camera's target stays inside it.

## Growing the map

1. Change `AREA` in `src/data/area.ts`, and `LANDMARKS` if you want new labels.
2. Run `bun run bake`, then `bun run verify`. The budgets tell you when the city got too heavy.

The raw extent covers lat 50.857–50.892, lon 4.676–4.722; the area already reaches its east edge at the Abdij van Park. Growing past it means downloading more data first.

## Format changes

Bump `VERSION` in `format.ts` and the cache name in `public/sw.js` together. The round-trip test in `format.test.ts` and `baked.test.ts` guard the rest.

## Attribution

The city data must be credited wherever it is shown. The HUD shows "© OpenStreetMap" and "© Digitaal Vlaanderen" in the top-end corner at start, then collapses them to a © button (DESIGN.md has the rules, and the smoke test checks it). Don't remove it or start it collapsed.

- **GRB and DHMV II:** "Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen".
- **OpenStreetMap:** "© OpenStreetMap contributors", ODbL. The combined building data is an ODbL derivative, so it stays open.
