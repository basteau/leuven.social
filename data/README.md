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
| `ortho/z18/{x}_{y}.png` | 1016 orthophoto tiles (z18, ~0.37 m/px, 82 MB) over the map area, for roof colours (`tools/fetch_ortho.py`) | Digitaal Vlaanderen WMTS `omwrgbmrvl` (most recent winter mosaic) | [Modellicentie Gratis Hergebruik v1.0](https://data.vlaanderen.be/id/licentie/modellicentie-gratis-hergebruik/v1.0); "Bron: Luchtopnamen Digitaal Vlaanderen" |
| `derived/leuven_buildings.geojson` | Each GRB footprint with **height**, eave, roof pitch, roof colour, ground level, OSM tags and **detail tier** | built by `tools/build_leuven_data.py` | GRB + DHMV II + orthophotos + OSM (ODbL applies to the combined database) |
| `derived/leuven_buildings_local.json` | Same buildings in a compact **game format**: local metres, origin at Grote Markt, x = east, z = south (three.js convention), courtyards as `holes` | same | same |
| `derived/lidar_trees.json` | 10.6k tree crowns of 10 m and up found in the LiDAR canopy, with their heights | same | © Digitaal Vlaanderen |
| `derived/osm_roads.geojson`, `osm_areas.geojson`, `osm_points.geojson` | OSM layers converted to GeoJSON (10,359 roads, 9,477 areas, 11,710 points) | same | ODbL |
| `derived/road_zones.json` | The GRB road surface cut along its WGO kerb lines into ~1,100 carriageway and cycle-track faces (with the tags of the OSM way along each), ~380 lane lines and painted cycle lanes, ~780 crossings; local metres like the buildings | built by `tools/build_road_zones.py` | GRB + OSM (ODbL) |
| `derived/preview_heights.png` | Top-down preview map | same | — |

## How heights are computed
For every GRB footprint, the script samples the 1 m pixels inside it and computes:

| Field | Meaning |
|---|---|
| `ground_taw` | Median DTM inside the footprint, in m TAW |
| `height` | **p90** of (DSM − DTM), so roof ridges count but antennas and cranes don't |
| `height_median` | Median of (DSM − DTM) |
| `height_max` | Maximum of (DSM − DTM) |

It also reads the roof itself:

| Field | Meaning |
|---|---|
| `eave` | p15 of (DSM − DTM): where the roof starts. Equal to `height` on a flat roof |
| `roof_pitch` | Share of pixels, 1 m in from the walls, whose DSM slope is 15–60°. Above 0.4 the roof counts as pitched (`PITCHED_SHARE` in `src/data/city.ts`) |
| `roof_rgb` | Median colour of the brighter half of the roof's orthophoto pixels, 1 m in from the walls (shadows and gutters drop out), then grey-world white-balanced over all roofs |

And the trees nobody mapped: local maxima of the canopy (DSM − DTM, 10–35 m) within 3 m, at least 1.5 m clear of any GRB building or annex, on rough surfaces only (a crown, not a flat shed), spaced by the crown size the viewer draws for that height. Smaller trees are left out to keep the render budget. `bun run bake` merges them with OSM's mapped trees.

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
uv run --with numpy --with tifffile --with shapely --with pyproj --with matplotlib --with pillow python -I tools/build_leuven_data.py data
```

The road zones come from GRB and OSM only and take a few seconds, so they have their own script:
```bash
uv run --with numpy --with shapely python -I tools/build_road_zones.py data
```

The orthophoto tiles are optional (without them roofs get no sampled colour). Fetch the ~1000 z18 tiles over the map area (skips the ones you have):
```bash
python3 -I tools/fetch_ortho.py data
```
The download commands (WFS paging, WCS tiling, Overpass with mirror failover) are documented in [`../research/leuven-data-sources.md`](../research/leuven-data-sources.md).

## Not downloaded (large or keyed)
| Data | Size or reason | Where to find it |
|---|---|---|
| De Lijn GTFS | ~186 MB | §5 of the sources doc |
| NMBS GTFS | ~44 MB | §5 of the sources doc |
| 3D GRB shapefile | Needs a login | §1b of the sources doc |
| Blue-bike GBFS | Live feed; fetch it at runtime | §5 of the sources doc |
| Fonske Sketchfab model | Needs a Sketchfab account | §3 of the sources doc |
