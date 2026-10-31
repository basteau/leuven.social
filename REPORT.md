# leuven.social: research report

**A browser-based 3D Leuven, in the spirit of mrdoob's Slop New York, but cartoony and pixel-ish**

_Compiled 2026-10-31. Everything referenced here is in this folder; see [§9](#9-folder-map)._

![Leuven: R23 ring + Heverlee, GRB footprints coloured by LiDAR height](data/derived/preview_heights.png)

_The map above was built from the data in this folder: 20,967 real building footprints with heights computed from LiDAR, the Dijle river, parks, streets, the R23 ring (dashed line) and six "hero" zones (green circles)._

---

## TL;DR

- **Slop New York** is an MIT-licensed, no-build-step three.js app. It uses WebGPU and TSL (three.js's node-based shader language) and was largely AI-assisted ("slop"). Its README says "fork it, remix it". It has 447★ and 150 forks after 11 days, and the [Awesome Slop Cities](https://github.com/zz85/slop-cities) list has about 40 city remixes. **There is no Belgian city on that list yet.** The closest neighbour is [Slop Utrecht](https://github.com/bertt/slop-utrecht). Several stylised spin-offs prove the cartoony direction works: Tiny Warsaw, tiny.london, isometric.nyc, abirdcity.
- **Leuven's data is better than NYC's** for this purpose:
  - Flanders publishes **survey-grade building footprints (GRB)** and **1 m LiDAR terrain and surface models (DHMV II)** as open data through keyless APIs.
  - OSM building heights are poor (≈0.5% tagged), so heights come from LiDAR.
  - There is no usable city open-data portal. OSM and Flemish services cover the gap.
- **Already done:** the data for the whole game area is downloaded, and turned into a game-ready building file with heights and **detail tiers** (hero / core / fringe), using [`tools/build_leuven_data.py`](tools/build_leuven_data.py).
- **Recommended stack:**
  - Vanilla **three.js r187 `WebGPURenderer` + TSL**, with Vite and TypeScript (Bun for scripts).
  - **Rapier** for physics, **recast-navigation-js** for crowds, **Colyseus + Yjs** for the social layer.
  - The pixel/toon look comes from three's built-in TSL nodes (`PixelationPassNode`, `ToonOutlinePassNode`, `MeshToonNodeMaterial`).
  - Assets: Blockbench, Pixelorama and Kenney/Quaternius CC0 kits.
- **Performance budget:** extruding every building comes to about **560k triangles** and about **1.2 MB gzipped**. That is easily real-time. The "pixel" look also lets us render at ¼–⅓ resolution, which is a big performance win on phones.

---

## 1. Slop New York teardown

**Links:** [repo](https://github.com/mrdoob/slop-newyork) · [live](https://mrdoob.github.io/slop-newyork/). It was studied from a local clone at commit `e35c06c` (2026-10-29), along with the [Slop Cities list](https://github.com/zz85/slop-cities/blob/gh-pages/cities.yml). Neither is part of this repo.

### 1.1 What it is

- A Manhattan simulation, from 125th St down to Battery Park.
- **Four ways to move:** walk, car (yellow cab), bicycle, helicopter.
- **Cameras:** 11 cinematic presets.
- **Four time-of-day looks:** Golden Hour, Midday, Blue Hour, Night.
- **UI extras:** teleport menu, live minimap, full-screen map (M), procedural audio, touch and gamepad controls.
- **Licences:** code MIT. Data: NYC Open Data footprints, heights and trees, MTA subway entrances, and OSM (ODbL).

### 1.2 Tech stack

- **No bundler, no framework.** `index.html` pulls in an importmap of `three/webgpu`, `three/tsl` and addons, pinned to a three.js dev commit on jsDelivr, plus about 50 ES modules with `modulepreload`. About 33k lines of plain JS.
- **Renderer:** `WebGPURenderer` with a reversed depth buffer, pixel ratio 1, and `ClusteredLighting` so thousands of street and car lights stay cheap.
- **Post-processing:** SSR, bloom, a per-time-of-day grade (exposure, contrast, white balance) and ACES tone mapping, all as TSL nodes (`post-processing.js`).
- **Materials (`tsl-materials.js`, 3.4k lines):** procedural TSL shaders for pre-war brick, curtain walls, billboards and water. There are almost no textures; windows and façades are computed in the shader.

### 1.3 Module map (useful as a blueprint)

| Concern    | Modules                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data       | `nyc-geodata.js` (generated), `building-geodata.js` + `.bin.gz`, `tree-geodata.js` + `.bin.gz`, `subway-geodata.js`                                                                                                       |
| City build | `city-grid.js`, `boroughs.js`, `buildings.js`, `building-details.js`, `building-footprints.js`, `fire-escapes.js`, `landmarks.js`, `street-details.js`, `street-props.js`, `road-network.js`, `road-paint.js`, `trees.js` |
| Simulation | `traffic.js` (2.5k lines), `cars.js`, `bus.js`, `vehicle-physics.js` (custom, no physics engine), `pedestrians.js`, `pedestrian-system.js`, `pedestrian-routes.js`                                                        |
| Player     | `controllers.js` (walk/car/bike/heli), `cameras.js`, `touch-controls.js`, `gamepad-controls.js`, `building-collision.js` (2D polygon collision)                                                                           |
| Rendering  | `lighting.js`, `post-processing.js`, `scene-culling.js`                                                                                                                                                                   |
| UI / audio | HTML/CSS HUD in `index.html`, `nyc-map.js` (canvas minimap), `audio-*.js` (fully synthesised WebAudio, no sample files)                                                                                                   |
| Tests      | `tests/*.test.cjs` (node test runner) for traffic, pedestrians, geodata, cameras and more                                                                                                                                 |

### 1.4 Data pipeline (`tools/`)

- **`overpass.sh`:** Overpass with mirror failover, retries and JSON validation before an atomic rename. We hit the same Overpass overload today and used the same tactic.
- **`build-buildings.py`** (Shapely):
  - Projects footprints into a local metre frame: origin at 5th Ave & 42nd St, x/z axes rotated 29° to Manhattan's grid.
  - Snaps coordinates to 0.5 m and heights to 1 m.
  - Writes a **custom binary format, "NYB1"**: zigzag varint deltas, gzipped. That is 37,353 buildings in **432 KB**. The browser inflates it with `DecompressionStream`.
- **`build-geodata.mjs`:** generates streets, blocks, parks, piers and a road graph from NYC's street-centreline dataset plus OSM.

### 1.5 Performance tricks worth stealing

- **`scene-culling.js`:**
  - Splits the city-wide instanced meshes into spatial chunks, each culled by the view frustum and by distance.
  - Uses **position-only shadow proxies** on a separate layer, so only cells within the ~300 m shadow cascades cast shadows.
- **Shader warm-up behind the loading screen.** Its progress bar is the only real progress measure.
- **Procedural detail instead of geometry.** Windows and façade rhythm live in TSL functions of UV and world position.
- **Binary, delta-encoded geodata.** Loads fast and parses fast.

### 1.6 What _not_ to copy as-is

- The geometry code is **Manhattan-specific**: grid-rotated frame, avenue and street indices, CSCL road classes. Leuven is a medieval radial street pattern.
  - **Fork the architecture and the generic modules:** controllers, cameras, audio, culling, the binary format, the HUD.
  - **Don't fork the city builder.**
- The photoreal goal (SSR, ACES, PBR) is the opposite of the look we want. Our version gets _simpler and cheaper_.

### 1.7 The ecosystem: relevant remixes

| Remix                                                                                                         | Why it matters                                                      |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Tiny Warsaw](https://tinywarsaw.app/)                                                                        | Low-poly city; the closest to our target look                       |
| [isometric.nyc](http://isometric.nyc) · [tiny.london](https://tiny.london/) · [tinygyn](https://tinygyn.com/) | Isometric pixel-art maps of whole cities                            |
| [abirdcity](https://abirdcity.com/city/daejeon?lang=en)                                                       | Whole city from OSM, in PlayCanvas                                  |
| [Slop Utrecht](https://github.com/bertt/slop-utrecht)                                                         | Nearest neighbour: Low Countries, Dutch open data                   |
| [Slop NY Mini](https://github.com/mattiaongit/slop-newyork-mini)                                              | Phone mode at 60 fps                                                |
| [Denzy7 performance rewrite](https://github.com/Denzy7/slop-newyork)                                          | For weak GPUs and browsers without WebGPU                           |
| [Slop Indore](https://github.com/animishraa05/slop-indore)                                                    | Structured as a "swap the city data" template                       |
| [Sevilla Sim](https://github.com/rnachoc/sevilla-sim)                                                         | Old town plus public bikes (Sevici); close to Leuven's bike culture |
| [London Loop](https://github.com/nelsonchris1/london-loop)                                                    | Bus driving on real routes and timetables; GTFS idea                |

**Opportunity:** Leuven would be the **first Belgian slop city**. Once it's live, a PR to `zz85/slop-cities` adds it to the list and the world map.

---

## 2. Scope: map extent and the detail-versus-performance trade-off

### 2.1 Extent

**Ring + inside + a buffer + a slice of Heverlee:**

- lat 50.857–50.892, lon 4.676–4.722
- About 3.3 × 3.9 km, roughly 13 km²
- Includes Kasteel Arenberg, the Arenberg campus, Heverlee station and the Naamsestraat axis south of the ring

That is small enough to load in one go. There's no need for streaming or 3D Tiles.

### 2.2 Three detail tiers

Each building in [`data/derived`](data/derived) already carries one of these tiers.

**Hero** (895 buildings in 6 zones). Treatment:

- Hand-made low-poly landmark models (Blockbench or Blender): Stadhuis, Sint-Pieterskerk, University Library tower, the Oude Markt façades, the Begijnhof, Kasteel Arenberg, the station.
- Fonske as a decimated CC-BY scan or a stylised remodel.
- Props and NPC crowds.

Hero zones:

- Grote Markt
- Oude Markt
- Ladeuzeplein
- Martelarenplein / station
- Groot Begijnhof
- Kasteel Arenberg

**Core** (10,107 buildings, inside R23). Treatment:

- Procedural **Flemish row houses**: the real footprint and height, a steep gabled roof with the ridge parallel to the street, and occasionally a stepped gable.
- Brick, or white/pastel plaster colour from a palette.
- Windows drawn in a TSL shader.
- Trees instanced from OSM.

**Fringe** (9,965 buildings, outside the ring and in Heverlee). Treatment:

- Extruded blocks with a flat or simple hip roof, flat colour, no windows.
- Grouped into a few big merged meshes.
- Cast no shadows, or use cheap proxies.

**Budgets** (initial targets to hit on a mid-range phone):

| Item                 | Budget                                                        |
| -------------------- | ------------------------------------------------------------- |
| Fringe               | ≤ 150k triangles total                                        |
| Core                 | ≤ 600k triangles total, chunked into ~250 m cells for culling |
| Each hero landmark   | ≤ 30–60k triangles                                            |
| Trees and bike racks | Instanced, ≈ 4k trees and ≈ 1.9k bike-parking spots           |
| Draw calls           | ≤ 300                                                         |
| Render resolution    | ¼–⅓ when using the pixelation look (resolution scale ≈ 3–4)   |

Rules of thumb:

- **Accuracy where people look; plausibility elsewhere.** Real footprints everywhere, since they're free and survey-grade. Real heights everywhere. Hand-crafted detail only in the hero zones.
- **Pixelation hides missing detail.** At an effective 320–480 px vertical resolution, procedural façades read as "detailed" without any geometry.
- **Top-down or isometric camera first.** It hides interiors and streetscape gaps, and caps how much is visible at once. A third-person street-level mode can come later in the hero zones.

---

## 3. Data: what we have and where it comes from

Full details, endpoints and gotchas are in **[research/leuven-data-sources.md](research/leuven-data-sources.md)**. Contents of `data/` are described in **[data/README.md](data/README.md)**.

| Need                                      | Best source                                                                                                               | Status                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Building footprints                       | **GRB** (`GRB:GBG`, cm-accurate), via keyless WFS                                                                         | ✅ 20,971 buildings                                       |
| Building heights                          | **DHMV II** LiDAR DSM − DTM (1 m), via keyless WCS. Alternative: 3D GRB LOD1 (login)                                      | ✅ computed per footprint                                 |
| Terrain                                   | DHMV II DTM 1 m (11–77 m TAW in our extent: Dijle valley, Keizersberg, Kessel-Lo slopes)                                  | ✅                                                        |
| Roads, sidewalks                          | GRB `WBN`/`WGO` polygons (exact surfaces) + OSM highways (names, classes, one-ways, cycleways)                            | ✅                                                        |
| Water                                     | GRB `WTZ` + OSM (Dijle, Voer, Vaartkom)                                                                                   | ✅                                                        |
| Parks, land use, rail                     | OSM                                                                                                                       | ✅                                                        |
| Trees                                     | OSM `natural=tree` (3,839 in extent). There is no city tree register.                                                     | ✅                                                        |
| POIs: cafés, bars, bike parking, heritage | OSM                                                                                                                       | ✅ 175 bars/pubs/cafés, 1,911 bike parkings, 278 historic |
| Building type, roof shape, names          | OSM, joined to GRB footprints (86% matched)                                                                               | ✅                                                        |
| Landmark visuals                          | Wikimedia Commons, orthophotos (WMTS), heritage inventory, historic maps (Ferraris 1777, Popp)                            | links                                                     |
| 3D landmark models                        | Only Fonske (CC-BY, Sketchfab). **Everything else must be hand-modelled.**                                                | link                                                      |
| Live flavour                              | Blue-bike GBFS (54 stations around Leuven), De Lijn and NMBS GTFS, Telraam traffic counts (a Leuven-born citizen project) | links                                                     |

**Key facts and gotchas:**

- **Heights come from LiDAR flown in 2013–2015.** Anything built since then has a wrong height, so a small manual-override table is needed.
- The DSM includes trees, so small buildings under canopy can look too tall. The p90 statistic softens this.
- **OSM in Belgium imported GRB**, so OSM and GRB footprints agree. That is why the tag join works so well.
- WCS fails above roughly 2–3k px per side, so tile it. WFS pages of 2,500 features are reliable; 5,000 sometimes return 504.
- **Licences:**
  - GRB and DHMV: free with attribution ("Bron: … Digitaal Vlaanderen").
  - OSM: ODbL, which means **the combined building database must stay open (share-alike)**. Credit everything on an in-game credits screen, as slop-newyork does in its README.

---

## 4. Art direction: "cartoonish / pixely" Leuven

### 4.1 Three viable looks, in order of recommendation

1. **Toon-shaded low-poly with a pixel post-pass** (Tiny Warsaw meets _A Short Hike_):
   - `MeshToonNodeMaterial` with a 3–4 step gradient.
   - `ToonOutlinePassNode` or a depth/normal Sobel pass for ink lines.
   - `PixelationPassNode` at ¼ resolution with nearest upscale.
   - A **palette-quantise + Bayer-dither** TSL node with a fixed Lospec palette.
   - The cheapest of the three, and it looks deliberate.
2. **Isometric diorama:**
   - Orthographic camera at the true isometric angle (≈35.26° pitch, 45° yaw), snapped to texel size to stop pixel crawl.
   - Closest to isometric.nyc and tiny.london, but interactive and 3D.
   - Rotation in 90° steps keeps the pixel grid stable.
3. **PS1 retro:**
   - `RetroPassNode` (vertex snapping, affine textures).
   - Fun for a night or "student party" mode. Could be a toggle.

### 4.2 A Leuven visual vocabulary for the procedural generator

**Row houses (`house`, 10.7k buildings, about half the city):**

- 5–8 m wide and deep, 2–4 storeys.
- Steep **saddle roofs** with the ridge parallel to the street; dormers.
- Red-brown brick or white, cream or pastel plaster; dark slate or red tile roofs.
- In the hero and core zones, some get **stepped gables (trapgevels)** or bell gables.

**Other building types:**

- **Retail ground floors** (`retail`, 633): shopfront band, awning colour, café terraces. On Oude Markt that means café chairs and parasols.
- **University and institutional** (`university`, `dormitory`, the Arenberg campus): bigger blocks, light stone colour, and the KU Leuven blue as an accent.
- **Churches and towers:** most heights come from LiDAR. Sint-Pieterskerk's truncated tower, the University Library's 87 m tower and the Stadhuis's spires get hero models.

**Ground and water:**

- Cobblestone (kassei) squares as a pixel texture.
- Cycle lanes in red asphalt.
- The Dijle as a stylised water shader with bridges from GRB `KNW`.

**Palette:**

- Warm brick and terracotta, slate blue-grey, KU Leuven blue, Stella red, and lots of green (parks and the Kruidtuin).
- Golden-hour and blue-hour presets, like slop-newyork's `LOOKS`.

### 4.3 Asset workflow (all FOSS)

1. **Blockbench** for cartoon landmarks with pixel textures.
2. **Pixelorama** or LibreSprite for textures and sprites.
3. Blender 5.2 LTS only where needed (Stadhuis).
4. Export glTF, then `gltf-transform optimize --compress meshopt`.
5. CC0 kits from Kenney, Quaternius and KayKit for bikes, people, benches, street lamps and cars.

For real LOD2 roofs in the core later on, run **roofer** (the 3D BAG pipeline) offline on DHMV point clouds.

---

## 5. Recommended FOSS stack

Full landscape, with versions and licences checked live on 2026-10-31: **[research/foss-tooling.md](research/foss-tooling.md)**.

| Layer                        | Pick                                                                                                                                                | Alternatives / notes                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Renderer                     | **three.js r187 `WebGPURenderer` + TSL**. WebGPU now ships in Chrome, Edge, Safari 26 and Firefox (Win/macOS). Automatic WebGL2 fallback otherwise. | Babylon.js 9, PlayCanvas 2.23. Avoid Needle (proprietary EULA).                                            |
| App shell                    | **Vite 8 + TypeScript 7**, Bun 1.4 for scripts                                                                                                      | Or stay no-build like mrdoob (importmap) for the first prototype                                           |
| Declarative layer (optional) | React Three Fiber v9.8 (v10 alpha makes WebGPU and TSL first-class) + drei + zustand                                                                | Threlte (Svelte), TresJS (Vue)                                                                             |
| Toon / pixel look            | three's TSL nodes: `PixelationPassNode`, `ToonOutlinePassNode`, `MeshToonNodeMaterial`, `RetroPassNode`, `GTAONode`, `Lut3DNode`                    | pmndrs/postprocessing is WebGL-only; it doesn't mix with WebGPURenderer                                    |
| Physics / character          | **Rapier** (`@dimforge/rapier3d-compat` 0.21, KinematicCharacterController); bike and car can be kinematic                                          | JoltPhysics.js 1.1 if vehicles get serious. slop-newyork shows a hand-rolled 2D collision is often enough. |
| NPCs                         | **recast-navigation-js** 0.44 (navmesh + crowd) for students and pedestrians; yuka for steering                                                     | —                                                                                                          |
| ECS                          | Koota (pmndrs) or bitECS                                                                                                                            | Plain classes are fine early on                                                                            |
| Picking                      | three-mesh-bvh                                                                                                                                      | —                                                                                                          |
| Multiplayer                  | **Colyseus 0.18** (authoritative rooms, e.g. one per neighbourhood)                                                                                 | PartyServer (Cloudflare), Trystero (P2P prototype). Avoid Playroom (proprietary).                          |
| Shared persistent state      | **Yjs** (pins, notes, graffiti walls)                                                                                                               | Nakama for accounts, friends and leaderboards                                                              |
| HUD / UI                     | HTML/CSS overlay (pixel font) + pmndrs **uikit** for in-world signs                                                                                 | lil-gui or the three Inspector for debugging                                                               |
| Audio                        | WebAudio (synthesised like slop-newyork) + Tone.js for carillon bells and chiptune                                                                  | Howler (stable, unmaintained)                                                                              |
| Minimap                      | Canvas 2D from our GeoJSON, or MapLibre GL 6 + Protomaps/PMTiles                                                                                    | Historic Ferraris map as an "old map" skin                                                                 |
| Data build                   | Python (shapely, tifffile, pyproj via `uv`) **or** DuckDB 2.0 spatial + GDAL 3.13; turf + earcut in JS                                              | Overture CLI is unnecessary for Flanders                                                                   |
| Asset pipeline               | glTF-Transform 4.5 + meshoptimizer 1.3; KTX2 only for large textures                                                                                | —                                                                                                          |

**Recommended path:**

- **Option A**, vanilla three.js + Vite, written mrdoob-style.
- Copy the _patterns_ from slop-newyork: binary geodata, chunked culling, shadow proxies, controllers, HUD, synthesised audio.
- Write a new Leuven city builder on top of `data/derived/leuven_buildings_local.json`.
- Switch to R3F only if the UI or social layer grows large; R3F v10 should be out of alpha by then.

---

## 6. Game ideas: what makes it _Leuven_ and _social_

**Bikes first, cars last**

- Leuven is a cycling city, so the default vehicle is a bike.
- Spawn at Blue-bike stations; the live GBFS feed shows real dock availability.
- The car is slow and annoying, a nod to the traffic-circulation plan that closes the centre to through traffic.

**Real time of day**

- Golden hour over the Oude Markt, blue hour at the Ladeuzeplein.
- Carillon bells from the University Library tower and Sint-Pieter on the hour, synthesised with Tone.js.

**Things to do**

- **"Find Fonske" and landmark hunts:** collectibles at the 25 POIs (table in the sources doc), with Wikimedia facts as cards.
- **Courier missions:**
  - Fries from a frituur, or a vat from the Stella Artois brewery to the Oude Markt, against the clock.
  - Cobblestones slow you down; cycle lanes speed you up.
  - Heverlee gives a downhill run from Arenberg to the ring.
- **Student-life layer:**
  - Find your kot, get to your exam in the Arenberg castle on time.
  - Dodge the morning rush on Naamsestraat.
  - A cantus singalong as a rhythm minigame.
- **"Old Leuven" mode:** the 1777 Ferraris map as ground texture; the city walls and Dijle arms return.

**Social (leuven.social)**

- Other players as little pixel avatars in shared Colyseus rooms.
- Drop pins and notes on cafés ("I'm at Oude Markt, come by") as Yjs shared state.
- Events on the map, emotes, and proximity chat.

**Live data hooks, cheap but magical**

- Telraam counts drive NPC cyclist density per street.
- De Lijn GTFS drives buses on real routes, à la London Loop.

---

## 7. Proposed roadmap

1. **Viewer (1–2 days):**
   - Vite + three WebGPU app that loads `leuven_buildings_local.json`.
   - Extrudes footprints by tier, puts the DTM under them, adds a toon material, an isometric orthographic camera and the pixelation pass.
   - Goal: "it's Leuven" at first glance.
2. **Ground layer:**
   - Roads and sidewalks from GRB `WBN`/`WGO`, the Dijle, parks, instanced trees.
   - A binary chunked format like NYB1, built at compile time.
3. **Procedural core:** row-house roofs and gables, façade TSL shader, palette and dithering.
4. **Hero landmarks:** Stadhuis and Sint-Pieter first, then the library tower, the Oude Markt row, Arenberg castle, the station.
5. **Play:**
   - Bike controller (Rapier character or kinematic), touch and gamepad.
   - Teleports to hero zones, minimap, the first collectible loop.
6. **Social:** Colyseus room per zone, avatars, pins (Yjs), events.
7. **Ship:**
   - Static hosting (GitHub Pages or Cloudflare) plus a small Colyseus server.
   - Credits screen.
   - PR to Awesome Slop Cities.

---

## 8. Caveats and open questions

- **Gameplay detail is still open.** It decides the camera: isometric, top-down or third-person. The data supports all three.
- **The R23 tier boundary** uses the convex hull of the ring. It's close enough for tiering, but use the real ring polyline for anything visible.
- **Heights:**
  - The LiDAR is from 2013–15.
  - A few `height_max` outliers (102 m) are cranes or LiDAR artefacts. Use `height` (p90), not `height_max`.
  - Check the hero buildings by hand.
- **Licensing:**
  - The combined building file is an ODbL derivative because it includes OSM tags. Keep it open, and attribute GRB, DHMV and OSM.
  - Landmark photos from Commons carry per-file licences.
- **Facts are approximate:** student numbers, Oude Markt café count, tower heights. Verify before putting them on in-game cards.
- **Not downloaded:** GTFS feeds (large), orthophoto tiles, the 3D GRB shapefile (login), Fonske (Sketchfab account). All the endpoints are documented.

---

## 9. Folder map

Folders marked _local_ are gitignored: they hold large raw downloads or third-party material that is fetched, not published.

```
leuven.social/
├── REPORT.md                       ← this file
├── tools/build_leuven_data.py      ← GRB × LiDAR × OSM → game data (+ preview)
├── data/
│   ├── README.md                   ← contents, licences, rebuild command
│   ├── grb/        (local, 27 MB)  ← GRB footprints, annexes, roads, water, structures (GeoJSON)
│   ├── elevation/  (local, 119 MB) ← DHMV II DTM + DSM 1 m tiles, hillshade (GeoTIFF, EPSG:31370)
│   ├── osm/        (dumps local)   ← Overpass raw dumps (local) + the queries (tracked)
│   └── derived/    (local, 26 MB)  ← leuven_buildings(.geojson | _local.json), osm_*.geojson, preview_heights.png
└── research/
    ├── leuven-data-sources.md      ← every data source: endpoints, licences, gotchas, 25 POIs with coordinates
    ├── foss-tooling.md             ← FOSS landscape (versions verified 2026-10-31) + stack options
    └── slop-newyork/   (local)     ← clone of mrdoob/slop-newyork and the Slop Cities list, for reference
```

_Attribution: GRB and DHMV II © Digitaal Vlaanderen ("Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen"). Map data © OpenStreetMap contributors (ODbL). Slop New York © mrdoob et al. (MIT)._
