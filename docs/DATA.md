# City data

The app loads a single file, `public/data/city.bin`, which is about 750 KB gzipped for the whole R23 ring plus Heverlee. It's committed, so a fresh clone runs without the raw data.

## Pipeline

```
Flemish GRB footprints  ─┐
DHMV II LiDAR (DTM/DSM) ─┤
Orthophotos (WMTS)      ─┼─ tools/build_leuven_data.py ─▶ data/derived/ ─▶ bun run bake ─▶ public/data/city.bin
OpenStreetMap (Overpass) ┘        (Python, via uv)       (GeoJSON, JSON)   (scripts/bake.ts)
GRB road surface + OSM  ─── tools/build_road_zones.py ──▶ road_zones.json ─┘
```

1. **Raw downloads**, about 230 MB, gitignored. [data/README.md](../data/README.md) lists every source, licence and the exact queries. [research/leuven-data-sources.md](../research/leuven-data-sources.md) has the endpoints and gotchas.
2. **`tools/build_leuven_data.py`** joins GRB footprints (with their courtyards) with LiDAR heights (DSM − DTM, p90), surveys each roof (eave, share of pitched pixels, orthophoto colour), finds tree crowns in the LiDAR canopy, adds OSM tags and assigns a detail tier.
3. **`tools/build_road_zones.py`** cuts the GRB road surface (WBN) along its subdivision lines (WGO: kerbs, cycle and pedestrian zones), names each face from the OSM ways running along it, and lays out lane lines, painted cycle lanes and crossings on the carriageways. It needs only GRB and OSM, so it runs in seconds on its own.
4. **`bun run bake`** keeps what lies in `AREA` (`src/data/area.ts`), projects it to local metres, simplifies it and writes the binary `LVN1` format (`src/data/format.ts`).
   - Buildings are kept whole when every corner is inside the area; ground polygons are clipped to it.
   - Footprint vertices within 0.25 m (core) or 0.5 m (fringe) of the line through their neighbours are dropped; hero footprints keep every vertex, since landmark models are fitted to them. Ground polygons lose vertices within 0.3 m, and patches of green under 25 m² go.

## What the data decides

Prefer reading the world over guessing it. Each of these replaced a rule of thumb:

| What                      | From                                                                                                                                                      | Where                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Pitched or flat roof      | OSM `roof:shape`, else the LiDAR: over 40% of the roof sloped 15–60° is pitched                                                                           | `roofFromSurvey` in `src/data/city.ts`       |
| Roof rise and wall height | LiDAR p90 (ridge) minus p15 (eave), capped by the footprint's width                                                                                       | `planRoof` in `src/scene/buildings.ts`       |
| Roof shape                | Gable on near-rectangles, else a hipped roof over the footprint's straight skeleton                                                                       | `src/data/skeleton.ts`                       |
| Roof colour               | Median of the sunlit orthophoto pixels, snapped to the roof swatches                                                                                      | `roofColor` in `src/scene/palette.ts`        |
| Courtyards                | GRB polygon holes                                                                                                                                         | walls and roofs in `src/scene/buildings.ts`  |
| Trees and their heights   | OSM's mapped trees plus LiDAR canopy crowns outside every building                                                                                        | `mergeTrees` in `src/data/trees.ts`          |
| Paths                     | OSM footways, paths, cycleways, tracks and steps of their own, with width and surface                                                                     | `pathFromOsm` in `src/data/city.ts`          |
| Pavement and carriageway  | GRB kerb lines (WGO) split the road surface; a face is carriageway where an OSM road runs along it, cycle track where a cycleway does, pavement otherwise | `tools/build_road_zones.py`                  |
| Asphalt, setts or paving  | OSM `surface` of the road along each carriageway; ring and main roads darker                                                                              | `carriagewayKind` in `src/data/roads.ts`     |
| Lane lines, cycle lanes   | OSM `lanes`, `oneway` and `cycleway:*` on the road, spaced across the carriageway's measured width, stopping at junctions (GRB `kruispuntzone`)           | `lane_layout` in `tools/build_road_zones.py` |
| Zebras, cyclist crossings | OSM crossing ways and their `crossing` / `crossing:markings` tags, clipped to the carriageway                                                             | `crossingMarking` in `src/data/roads.ts`     |

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
- **Orthophotos** (roof colours only; no imagery ships): "Bron: Luchtopnamen Digitaal Vlaanderen", [Modellicentie Gratis Hergebruik v1.0](https://data.vlaanderen.be/id/licentie/modellicentie-gratis-hergebruik/v1.0). The HUD's "© Digitaal Vlaanderen" covers it.
- **OpenStreetMap:** "© OpenStreetMap contributors", ODbL. The combined building data is an ODbL derivative, so it stays open.
