# data/

Raw downloads and derived, game-ready files for **Leuven inside the R23 ring plus a buffer, and Heverlee down to Kasteel Arenberg**.

| | |
|---|---|
| Extent | lat 50.857–50.892, lon 4.676–4.722 (≈ 3.3 × 3.9 km) |
| Same extent in Lambert 72 | EPSG:31370, X 171,600–174,900 and Y 171,800–175,800 |
| Downloaded | 2026-10-31 |

## Layout
| Path | What | Source | Licence / attribution |
|---|---|---|---|
| `grb/grb_GBG.geojson` | 20,971 main building footprints (cm-accurate, EPSG:4326) | GRB WFS `GRB:GBG` | "Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen" |
| `grb/grb_GBA.geojson` | 4,486 building annexes | `GRB:GBA` | same |
| `grb/grb_WBN.geojson` | 2,383 road surfaces (polygons) | `GRB:WBN` | same |
| `grb/grb_WGO.geojson` | 12,429 road subdivisions (sidewalks, lanes…) | `GRB:WGO` | same |
| `grb/grb_WTZ.geojson` | 159 watercourses (Dijle, Voer…) | `GRB:WTZ` | same |
| `grb/grb_KNW.geojson` | 509 structures (bridges, walls…) | `GRB:KNW` | same |
| `elevation/leuven_DTM_1m_tile{1-8}.tif` | Terrain (bare earth), 1 m, Float32, m TAW, EPSG:31370; 2×4 tiles of 1650×1000 px | DHMV II WCS | © Digitaal Vlaanderen |
| `elevation/leuven_DSM_1m_tile{1-8}.tif` | Surface (incl. roofs and trees), same grid | DHMV II WCS | same |
| `elevation/leuven_hillshade_2m.tif` | Multidirectional hillshade, 8-bit, 2 m | DHMV II WCS | same |
| `osm/raw_*.json` | Overpass dumps (`out geom`): buildings, roads, water/landuse/rail, trees & POIs, R23 ring | Overpass API | © OpenStreetMap contributors, ODbL |
| `osm/queries/*.overpassql` | The exact queries | — | — |
| `derived/leuven_buildings.geojson` | Each GRB footprint with **height**, ground level, OSM tags and **detail tier** | built by `tools/build_leuven_data.py` | GRB + DHMV II + OSM (ODbL applies to the combined database) |
| `derived/leuven_buildings_local.json` | Same buildings in a compact **game format**: local metres, origin at Grote Markt, x = east, z = south (three.js convention) | same | same |
| `derived/osm_roads.geojson`, `osm_areas.geojson`, `osm_points.geojson` | OSM layers converted to GeoJSON (10,359 roads, 9,477 areas, 11,710 points) | same | ODbL |
| `derived/preview_heights.png` | Top-down preview map | same | — |

## How heights are computed
For every GRB footprint, the script samples the 1 m pixels inside it and computes:

| Field | Meaning |
|---|---|
| `ground_taw` | Median DTM inside the footprint, in m TAW |
| `height` | **p90** of (DSM − DTM), so roof ridges count but antennas and cranes don't |
| `height_median` | Median of (DSM − DTM) |
| `height_max` | Maximum of (DSM − DTM) |

Caveats:
- The LiDAR is from **2013–2015**. Buildings that are newer or demolished since then get wrong heights. Override those by hand.
- Overhanging trees can inflate the height of small buildings.

## Detail tiers (`tier` property)
| Tier | Rule | Count | Intended treatment |
|---|---|---|---|
| `hero` | Within a hand-picked radius of six landmark zones: Grote Markt, Oude Markt, Ladeuzeplein, Martelarenplein/station, Groot Begijnhof, Kasteel Arenberg | 895 | Hand-made landmark models plus detailed procedural façades |
| `core` | Inside the R23 ring (convex hull of the OSM `ref=R23` ways) | 10,107 | Procedural Flemish row houses with roofs, gables and windows |
| `fringe` | Outside the ring (including Heverlee) | 9,965 | Plain extruded blocks with simple roofs, no façade detail |

Edit `HERO_ZONES` in the script to change them.

## Rebuild
```bash
uv run --with numpy --with tifffile --with shapely --with pyproj --with matplotlib python -I tools/build_leuven_data.py data
```
The download commands (WFS paging, WCS tiling, Overpass with mirror failover) are documented in [`../research/leuven-data-sources.md`](../research/leuven-data-sources.md).

## Not downloaded (large or keyed)
| Data | Size or reason | Where to find it |
|---|---|---|
| De Lijn GTFS | ~186 MB | §5 of the sources doc |
| NMBS GTFS | ~44 MB | §5 of the sources doc |
| Orthophoto tiles | — | §3 of the sources doc |
| 3D GRB shapefile | Needs a login | §1b of the sources doc |
| Blue-bike GBFS | Live feed; fetch it at runtime | §5 of the sources doc |
| Fonske Sketchfab model | Needs a Sketchfab account | §3 of the sources doc |
