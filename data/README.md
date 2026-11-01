# data/

Raw downloads and derived files for the map: `AREA` in `src/data/area.ts` (the R23 ring with the station and its whole track bundle, and Heverlee from Arenbergpark to the Abdij van Park) plus a 100 m margin. Only this README and `sources.lock.json` are committed; the rest is about 230 MB.

Make it all with `bun run data:fetch` (downloads) and `bun run data:build` (derived files), or `bun run data` to bake `public/data/city.bin` too. [docs/DATA.md](../docs/DATA.md) explains the pipeline; `src/data/sources.ts` lists every source with its request, licence and credit. Don't download into this folder by hand: add a source there instead.

## Layout

| Path                                                       | What                                                                                                                                                     | Source id                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `sources.lock.json`                                        | Per source: files, bytes, SHA-256 and the date these bytes were first fetched. Committed with `city.bin`.                                                | —                            |
| `osm/buildings.json`, `ring_r23.json`, `roads.json`, `areas.json`, `points.json`, `furniture_ways.json`, `rail_platforms.json` | Overpass answers as of `OSM_DATE`, merged across tiles and sorted by type and id. Platforms keep their relation members (`out geom`) | `osm-buildings`, `osm-ring`, `osm-roads`, `osm-areas`, `osm-points`, `osm-furniture-ways`, `osm-rail-platforms` |
| `grb/grb_GBG.geojson`, `grb_GBA.geojson`, `grb_WBN.geojson`, `grb_WGO.geojson`, `grb_WTZ.geojson`, `grb_KNW.geojson` | GRB building footprints, annexes, road surfaces, road subdivision lines (kerbs, cycle and pedestrian zones), watercourses and structures (EPSG:4326), sorted by `OIDN` | `grb-gbg`, `grb-gba`, `grb-wbn`, `grb-wgo`, `grb-wtz`, `grb-knw` |
| `elevation/DTM/`, `elevation/DSM/`                         | DHMV II terrain and surface models, 1 m, Float32, m TAW, EPSG:31370, as GeoTIFF tiles named by their south-west corner                                    | `dhmv-dtm`, `dhmv-dsm`       |
| `ortho/z18/{x}_{y}.png`                                    | Orthophoto tiles (~0.37 m/px) over each rectangle of the area, for roof colours                                                                          | `ortho`                      |
| `derived/leuven_buildings.geojson`                         | Each GRB footprint with **height**, eave, roof pitch, roof colour, ground level, OSM tags and **detail tier**                                             | built                        |
| `derived/leuven_buildings_local.json`                      | The same buildings in a compact **game format**: local metres, origin at Grote Markt, x = east, z = south (three.js convention), courtyards as `holes`    | built                        |
| `derived/grb_structures.json`                              | GRB structures: bridge outlines (for their parapets), and tanks and silos with their LiDAR p90 height, in local metres                                   | built                        |
| `derived/lidar_trees.json`                                 | Tree crowns of 10 m and up found in the LiDAR canopy, with their heights                                                                                 | built                        |
| `derived/osm_roads.geojson`, `osm_areas.geojson`, `osm_points.geojson` | The OSM layers as GeoJSON                                                                                                                    | built                        |
| `derived/road_zones.json`                                  | The GRB road surface cut along its WGO kerb lines into ~1,100 carriageway and cycle-track faces (with the tags of the OSM way along each), ~300 lane lines and painted cycle lanes, ~740 crossings; local metres like the buildings | built                        |
| `derived/preview_heights.png`                              | Top-down preview map                                                                                                                                     | built                        |
| `.cache/`                                                  | Overpass tiles, so an interrupted fetch resumes                                                                                                          | —                            |

Licences: OpenStreetMap data is © OpenStreetMap contributors under the ODbL, and so is the combined building data. GRB, DHMV II and the orthophotos are Digitaal Vlaanderen's, under the Modellicentie Gratis Hergebruik v1.0. The credits are in `src/data/providers.ts`.

## How heights are computed

For every GRB footprint, the build samples the 1 m pixels inside it and computes:

| Field           | Meaning                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `ground_taw`    | Median DTM inside the footprint, in m TAW                                     |
| `height`        | **p90** of (DSM − DTM), so roof ridges count but antennas and cranes don't |
| `height_median` | Median of (DSM − DTM)                                                         |
| `height_max`    | Maximum of (DSM − DTM)                                                        |

It also reads the roof itself:

| Field        | Meaning                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eave`       | p15 of (DSM − DTM): where the roof starts. Equal to `height` on a flat roof                                                                                                            |
| `roof_pitch` | Share of pixels, 1 m in from the walls, whose DSM slope is 15–60°. Above 0.4 the roof counts as pitched (`PITCHED_SHARE` in `src/data/city.ts`)                                        |
| `roof_rgb`   | Median colour of the brighter half of the roof's orthophoto pixels, 1 m in from the walls (shadows and gutters drop out), then grey-world white-balanced over all roofs in the download |

And the trees nobody mapped: local maxima of the canopy (DSM − DTM, 10–35 m) within 3 m, at least 1.5 m clear of any GRB building or annex, on rough surfaces only (a crown, not a flat shed), spaced by the crown size the viewer draws for that height. Smaller trees are left out to keep the render budget. `bun run bake` merges them with OSM's mapped trees.

Caveats:

- The LiDAR is from **2013–2015**. Buildings built or demolished since then get wrong heights.
- Overhanging trees can inflate the height of small buildings.

## Detail tiers (`tier` property)

| Tier     | Rule                                                                                                                                         | Intended treatment                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `hero`   | Within a hand-picked radius of six zones (`HERO_ZONES` in the build): Grote Markt, Oude Markt, Ladeuzeplein, Martelarenplein, Groot Begijnhof, Kasteel Arenberg. The bake adds the footprints of `LANDMARK_FOOTPRINTS`. | Hand-made landmark models plus detailed procedural façades         |
| `core`   | Inside the R23 ring (convex hull of the OSM `ref=R23` ways)                                                                                   | Procedural Flemish row houses with roofs, gables and windows       |
| `fringe` | Outside the ring (including Heverlee)                                                                                                         | Plain extruded blocks with simple roofs, no façade detail          |

## Not downloaded (large or keyed)

| Data                   | Size or reason                  | Where to find it                                              |
| ---------------------- | ------------------------------- | ------------------------------------------------------------- |
| De Lijn GTFS           | ~186 MB                         | §5 of `research/leuven-data-sources.md`                       |
| NMBS GTFS              | ~44 MB                          | §5                                                            |
| 3D GRB shapefile       | Needs a login                   | §1b                                                           |
| Blue-bike GBFS         | Live feed; fetch it at runtime  | §5                                                            |
| Fonske Sketchfab model | Needs a Sketchfab account       | §3                                                            |
