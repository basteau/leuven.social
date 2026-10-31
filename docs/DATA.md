# City data

The app loads a single file, `public/data/city.bin`, which is about 125 KB gzipped. It's committed, so a fresh clone runs without the raw data.

## Pipeline

```
Flemish GRB footprints  ─┐
DHMV II LiDAR (DTM/DSM) ─┼─ tools/build_leuven_data.py ─▶ data/derived/ ─▶ bun run bake ─▶ public/data/city.bin
OpenStreetMap (Overpass) ┘        (Python, via uv)       (GeoJSON, JSON)   (scripts/bake.ts)
```

1. **Raw downloads**, about 230 MB, gitignored. [data/README.md](../data/README.md) lists every source, licence and the exact queries. [research/leuven-data-sources.md](../research/leuven-data-sources.md) has the endpoints and gotchas.
2. **`tools/build_leuven_data.py`** joins GRB footprints with LiDAR heights (DSM − DTM, p90), adds OSM tags and assigns a detail tier.
3. **`bun run bake`** clips everything to `VIEW_AREA` (`src/data/area.ts`), projects it to local metres and writes the binary `LVN1` format (`src/data/format.ts`).

## Coordinates

| Axis   | Meaning                       |
| ------ | ----------------------------- |
| origin | Grote Markt, metres           |
| x      | east                          |
| z      | south (three.js: north is −z) |
| y      | up                            |

`src/data/projection.ts` converts to and from WGS84.

## Growing the map

1. Change `VIEW_AREA` in `src/data/area.ts`, and `LANDMARKS` if you want new labels.
2. Run `bun run bake`, then `bun run verify`. The budgets tell you when the city got too heavy.

The raw extent already covers the R23 ring plus Heverlee (lat 50.857–50.892, lon 4.676–4.722).

## Format changes

Bump `VERSION` in `format.ts` and the cache name in `public/sw.js` together. The round-trip test in `format.test.ts` and `baked.test.ts` guard the rest.

## Attribution

The city data must be credited wherever it is shown. The HUD footer does this as a short linked line ("© OpenStreetMap · © Digitaal Vlaanderen"). Make it quieter if you like, but don't remove it.

- **GRB and DHMV II:** "Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen".
- **OpenStreetMap:** "© OpenStreetMap contributors", ODbL. The combined building data is an ODbL derivative, so it stays open.
