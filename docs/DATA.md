# City data

The app loads a single file, `public/data/city.bin`, which is about 660 KB gzipped for the whole R23 ring plus Heverlee. It's committed, so a fresh clone runs without the raw data.

## Pipeline

```
Flemish GRB footprints  ─┐
DHMV II LiDAR (DTM/DSM) ─┤
Orthophotos (WMTS)      ─┼─ tools/build_leuven_data.py ─▶ data/derived/ ─▶ bun run bake ─▶ public/data/city.bin
OpenStreetMap (Overpass) ┘        (Python, via uv)       (GeoJSON, JSON)   (scripts/bake.ts)
```

1. **Raw downloads**, about 230 MB, gitignored. [data/README.md](../data/README.md) lists every source, licence and the exact queries. [research/leuven-data-sources.md](../research/leuven-data-sources.md) has the endpoints and gotchas.
2. **`tools/build_leuven_data.py`** joins GRB footprints (with their courtyards) with LiDAR heights (DSM − DTM, p90), surveys each roof (eave, share of pitched pixels, orthophoto colour), finds tree crowns in the LiDAR canopy, measures GRB structures (tanks, silos) and keeps bridge outlines, adds OSM tags and assigns a detail tier.
3. **`bun run bake`** keeps what lies in `AREA` (`src/data/area.ts`), projects it to local metres, simplifies it and writes the binary `LVN1` format (`src/data/format.ts`).
   - Buildings are kept whole when every corner is inside the area; ground polygons are clipped to it.
   - Footprint vertices within 0.25 m (core) or 0.5 m (fringe) of the line through their neighbours are dropped; hero footprints keep every vertex, since landmark models are fitted to them. Ground polygons lose vertices within 0.3 m, and patches of green under 25 m² go.

## What the data decides

Prefer reading the world over guessing it. Each of these replaced a rule of thumb:

| What                      | From                                                                                                                                                                                                                     | Where                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Pitched or flat roof      | OSM `roof:shape`, else the LiDAR: over 40% of the roof sloped 15–60° is pitched                                                                                                                                          | `roofFromSurvey` in `src/data/city.ts`                                  |
| Roof rise and wall height | LiDAR p90 (ridge) minus p15 (eave), capped by the footprint's width                                                                                                                                                      | `planRoof` in `src/scene/buildings.ts`                                  |
| Roof shape                | Gable on near-rectangles, else a hipped roof over the footprint's straight skeleton                                                                                                                                      | `src/data/skeleton.ts`                                                  |
| Roof colour               | Median of the sunlit orthophoto pixels, snapped to the roof swatches                                                                                                                                                     | `roofColor` in `src/scene/palette.ts`                                   |
| Courtyards                | GRB polygon holes                                                                                                                                                                                                        | walls and roofs in `src/scene/buildings.ts`                             |
| Trees and their heights   | OSM's mapped trees plus LiDAR canopy crowns outside every building                                                                                                                                                       | `mergeTrees` in `src/data/trees.ts`                                     |
| Paths                     | OSM footways, paths, cycleways, tracks and steps of their own, with width and surface                                                                                                                                    | `pathFromOsm` in `src/data/city.ts`                                     |
| Bridge parapets           | GRB structures (KNW) of type bridge: the sides whose outside is water get a low stone wall                                                                                                                               | `bridgeParapets` in `src/data/structures.ts`                            |
| Tanks and silos           | GRB structures (KNW) of type silo/tank and chemical plant, at their LiDAR p90 height; under 2.5 m left out                                                                                                               | `tankOutline` in `src/data/structures.ts`, `tools/build_leuven_data.py` |
| Street furniture          | OSM lamps, benches, bike racks (and their capacity), bus stops (and shelters), statues, fountains, pumps; turned to face the nearest kerb, path or wall; none inside a building or the river                             | `propFromOsm`, `placeProps` in `src/data/props.ts`                      |
| Labels                    | Which places get one is a list of ids (`LANDMARKS` in `src/data/area.ts`): a Wikidata id on an OSM element, an OSM element, or a GRB footprint. Name (OSM `short_name`, else `name`) and position come from that element | `src/data/labels.ts`, `scripts/bake.ts`                                 |

### Sources for these layers

All of them come from downloads the pipeline already makes ([data/README.md](../data/README.md) has the queries):

- **GRB structures (`GRB:KNW`)**: GRB WFS `https://geo.api.vlaanderen.be/GRB/wfs`, `typeNames=GRB:KNW`, GeoJSON in EPSG:4326 over the raw extent (same paging as `GRB:GBG`, see [research/leuven-data-sources.md](../research/leuven-data-sources.md) §1). Licence: Modellicentie Gratis Hergebruik; credit "Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen" (the HUD's "© Digitaal Vlaanderen").
- **OSM points and their tags** (street furniture) and **every OSM element with its `wikidata` tag** (labels): the Overpass dumps `data/osm/raw_*.json`. ODbL; credit "© OpenStreetMap contributors" (the HUD's "© OpenStreetMap").

### Made by hand

Code, not data, each with its basis in a comment:

| What                                                                   | Basis                                                                                               | Where                       |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------- |
| Which places are labelled, their order and the zoom each shows from    | A choice of the landmarks, districts, parks and squares worth finding                               | `LANDMARKS` in `area.ts`    |
| Low-poly models of each kind of street furniture, and their 1.3× scale | Typical Leuven lamps, benches, racks and De Lijn shelters; scaled up so they read at zoom 2–4       | `src/scene/props.ts`        |
| The Totem's needle and beetle                                          | Jan Fabre's _Totem_ ([Q22446282](https://www.wikidata.org/wiki/Q22446282)); height from its OSM tag | `needle` in `props.ts`      |
| Bike racks 80% full, 6 stands where OSM has no capacity                | What Leuven's racks look like on a weekday                                                          | `props.ts` (data and scene) |
| Parapets 1.1 m tall, tanks under 2.5 m left out                        | A typical bridge parapet; tanks built after the 2013–15 LiDAR read as nothing                       | `structures.ts`, `bake.ts`  |

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

1. Change `AREA` in `src/data/area.ts`, and `LANDMARKS` if you want new labels: add the place's Wikidata id (as tagged in OSM), with the zoom it shows from.
2. Run `bun run bake`, then `bun run verify`. The budgets tell you when the city got too heavy.

The raw extent covers lat 50.857–50.892, lon 4.676–4.722; the area already reaches its east edge at the Abdij van Park. Growing past it means downloading more data first.

## Format changes

Bump `VERSION` in `format.ts` and the cache name in `public/sw.js` together. The round-trip test in `format.test.ts` and `baked.test.ts` guard the rest.

## Attribution

The city data must be credited wherever it is shown. The HUD shows "© OpenStreetMap" and "© Digitaal Vlaanderen" in the top-end corner at start, then collapses them to a © button (DESIGN.md has the rules, and the smoke test checks it). Don't remove it or start it collapsed.

- **GRB and DHMV II:** "Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen".
- **Orthophotos** (roof colours only; no imagery ships): "Bron: Luchtopnamen Digitaal Vlaanderen", [Modellicentie Gratis Hergebruik v1.0](https://data.vlaanderen.be/id/licentie/modellicentie-gratis-hergebruik/v1.0). The HUD's "© Digitaal Vlaanderen" covers it.
- **OpenStreetMap:** "© OpenStreetMap contributors", ODbL. The combined building data is an ODbL derivative, so it stays open.
