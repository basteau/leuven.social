# FOSS stack landscape for a stylised 3D Leuven city game

Checked on 2026-10-31. Star counts, latest releases, push dates and licences were pulled live from the GitHub GraphQL API and the npm registry. The remaining facts were checked on the project or official pages.

- Rows marked *(unverified)* come from general knowledge or a secondary source.
- Star counts are rounded.
- "push" means the date of the last commit pushed to the repo.

## 0. Reference project
| Name | URL | License | Status | Why for us |
|---|---|---|---|---|
| slop-newyork | github.com/mrdoob/slop-newyork | MIT | 447★, 150 forks, pushed 2026-10-29 | Built on three.js WebGPURenderer and TSL. You walk, drive, cycle or fly a helicopter. Plain `js/` modules with an importmap, no framework or bundler. The README invites forks. See [../REPORT.md](../REPORT.md) §1 for the full teardown. |

## 1. Rendering and engines
| Name | URL | License | Status / version | Why for us |
|---|---|---|---|---|
| three.js | github.com/mrdoob/three.js | MIT | **r187 (2026-10-30)**, 117k★, monthly releases | `WebGPURenderer` falls back to WebGL2 automatically. Node materials and TSL only run on WebGPURenderer (no `ShaderMaterial`/`onBeforeCompile` there). Recent releases added parallel `compileAsync`, an Inspector and better tree-shaking. |
| React Three Fiber | github.com/pmndrs/react-three-fiber | MIT | v9.8.2 stable; **v10.0.0-alpha.6** (WebGPU default, TSL hooks `useUniforms`/`useNodes`) | Option B. Move to v10 once it reaches beta. |
| drei | github.com/pmndrs/drei | MIT | 10.7.9; 11.0.0-alpha.7 pairs with R3F v10 | `<Outlines>`, `<Instances>`, `<KeyboardControls>`, `<Html>`, `<Bvh>`. |
| Threlte (Svelte) | github.com/threlte/threlte | MIT | core 8.6.1, extras 9.23.0 | Svelte alternative. WebGPU support is early. |
| TresJS (Vue) | github.com/Tresjs/tres | MIT | core 5.10.1 | Vue alternative, with @tresjs/rapier. |
| Babylon.js | github.com/BabylonJS/Babylon.js | Apache-2.0 | 9.33.1 | Batteries included: WebGPU, node material editor, Havok, GUI. Heavier than a minimal setup. |
| PlayCanvas engine | github.com/playcanvas/engine | MIT | v2.23.3 | Strong WebGPU and Gaussian splat support. The editor is SaaS; the engine is FOSS. abirdcity (Daejeon) is built on it. |
| PlayCanvas React / Web Components | github.com/playcanvas/react · /web-components | MIT | 0.11.7 / 0.28.1 | Declarative PlayCanvas, pre-1.0. |
| Godot 4 web export | github.com/godotengine/godot | MIT | 4.7.2 | Web export uses Compatibility (WebGL2) only, with no C# on web. A good editor but weaker as web-first. |
| Bevy | github.com/bevyengine/bevy | MIT/Apache-2.0 | v0.20.1 | Rust ECS. Large wasm bundles and breaking changes every release. *(web details unverified)* |
| Needle Engine | needle.tools | **Proprietary EULA, not FOSS** | 5.1.16 | Avoid. |
| A-Frame | github.com/aframevr/aframe | MIT | 1.8.0 | WebXR-oriented. Not a fit. |
| Phaser 4 / Excalibur | phaserjs/phaser · excaliburjs/Excalibur | MIT / BSD-2 | 4.2.1 / 0.32 | Only for a pure 2D fallback or HUD minigames. |

## 2. Stylisation: toon, outline, pixel, dither, splats
| Name | URL | License | Status | Why for us |
|---|---|---|---|---|
| three.js TSL post nodes | `examples/jsm/tsl/display/` | MIT | in r187 | `PixelationPassNode`, **`RetroPassNode`** (PS1: vertex snap, affine UVs, low-res, nearest), `OutlineNode`, `SobelOperatorNode`, `GTAONode`, `GodraysNode`, `Lut3DNode`, `DotScreenNode`. Core also has **`ToonOutlinePassNode`**. Examples: `webgpu_postprocessing_pixel`, `webgpu_postprocessing_retro`, `webgpu_materials_toon`, `webgpu_tsl_halftone`, `webgpu_tsl_occlusion_dither`. This covers the whole cartoon/pixel look with no dependencies. |
| three.js WebGL-path effects | same repo | MIT | – | `RenderPixelatedPass` (pixel art with depth/normal edge highlights), `OutlinePass`, `OutlineEffect`, `MeshToonMaterial` + gradientMap. |
| pmndrs/postprocessing | github.com/pmndrs/postprocessing | Zlib | 6.39.5; v7 beta | WebGL only. Not compatible with WebGPURenderer. |
| N8AO | github.com/N8python/n8ao | CC0/ISC | 2.0.1 | Cheap AO that gives a diorama look (WebGL path). On WebGPU use `GTAONode`. |
| three-good-godrays | github.com/Ameobea/three-good-godrays | permissive | 0.12.1, lags three | On WebGPU use `GodraysNode` instead. |
| **Spark** (World Labs) | github.com/sparkjsdev/spark | MIT | **v2.4.0 (2026-10-20)** | Gaussian splats in three.js, mixed with meshes. Reads PLY/SPZ/SPLAT/KSPLAT/SOG. Use for landmark captures. The README says WebGL2. |
| GaussianSplats3D | github.com/mkkellogg/GaussianSplats3D | MIT | 0.4.7 (2025) | Superseded by Spark. |
| SuperSplat | github.com/playcanvas/supersplat | MIT | v3.7.0 | Browser splat editor for cropping and cleaning. |
| three-edge-projection | github.com/gkjohnson/three-edge-projection | MIT | 0.0.11 | Vector line art from meshes, for a map or blueprint mode. |
| Lospec palettes | lospec.com/palette-list | free DB | – | Fixed palettes for a palette-quantise post node. |

## 3. Geo → 3D pipelines
| Name | URL | License | Status | Why for us |
|---|---|---|---|---|
| **3D GRB (Flanders)** | vlaanderen.be/…/3d-grb | open data, attribution | LOD1 only, 2016 heights | The authoritative footprints and heights. See leuven-data-sources.md. |
| OpenStreetMap + osmtogeojson | github.com/tyrasd/osmtogeojson | MIT | 3.0.0-beta.5 | Overpass → GeoJSON. Dormant but stable. |
| Overture Maps CLI | github.com/OvertureMaps/overturemaps-py | MIT | v1.0.2 | GeoParquet by bbox. Adds little over GRB for Flanders. |
| DuckDB + spatial | github.com/duckdb/duckdb | MIT | **v2.0.0 (2026-10-21)** | SQL over GeoParquet, shapefiles and PBF. Also runs in the browser via duckdb-wasm. |
| GDAL / QGIS | OSGeo/gdal · qgis/QGIS | MIT / GPL-2 | 3.13.3 / 4.2.x | Reproject EPSG:31370, clip and convert. QGIS for visual QA. |
| turf.js | github.com/Turfjs/turf | MIT | 7.4.0 | Buffers, offsets, point-in-polygon for gameplay zones. |
| earcut | github.com/mapbox/earcut | ISC | 3.2.4 | Footprint and roof triangulation. |
| OSM2World | github.com/tordanik/OSM2World | MIT | pushed 2026-10 | Java OSM → 3D with roofs and street furniture. Offline glTF bake *(glTF output unverified)*. |
| **Arnis** | github.com/louis-e/arnis | Apache-2.0 | **v3.4.0 (2026-10-31)**, 18k★ | OSM → Minecraft. Its tag-to-block mapping is a direct reference for a voxel or low-poly Leuven. |
| blosm (Blender-OSM) | github.com/vvoovv/blosm | check licence | 2.7.28 | OSM + terrain into Blender, for hand-dressing landmarks. |
| BlenderGIS | github.com/domlysz/BlenderGIS | GPL-3.0 | 2215 | DEM and shapefile import into Blender. |
| OSMBuildings / three-geo / geo-three | – | – | stale | Avoid. |
| 3DTilesRendererJS | github.com/NASA-AMMOS/3DTilesRendererJS | Apache-2.0 | v0.5.3 | Only needed if we tile the city as 3D Tiles. |
| MapLibre GL JS | github.com/maplibre/maplibre-gl-js | BSD-3 | v6.16.0 | FOSS minimap or overview. Mapbox GL v2+ is proprietary. |
| deck.gl / loaders.gl | visgl | MIT | 9.4.1 / 4.5.4 | Data overlays, plus parsers for Parquet, MVT and LAS. |
| giro3d / iTowns / CesiumJS | – | MIT / CeCILL-B / Apache | – | Reference viewers. Overkill for one city. |
| tippecanoe / PMTiles / Protomaps / Planetiler | felt · protomaps · onthegomap | BSD/Apache | active | Vector tiles and a single-file tile archive for the minimap and chunk streaming. |
| cjio | github.com/cityjson/cjio | MIT | 0.10.1 | CityJSON tooling, if LOD2 data ever appears. |
| **roofer** / 3dfier (3D BAG pipeline) | github.com/3DBAG/roofer | GPL-3.0 | roofer v1.0.0 | LiDAR + footprints → LOD2.2 roofs. Feed it DHMV II + GRB for real roof shapes. Offline tool only, so GPL does not reach the game. |
| @takram/three-geospatial | npm | MIT | 0.9.1 | Atmosphere and sky. Optional. |

## 4. Physics and gameplay
| Name | URL | License | Status | Why for us |
|---|---|---|---|---|
| Rapier | github.com/dimforge/rapier (`typescript/`) | Apache-2.0 | `@dimforge/rapier3d-compat` **0.21.0** (the rapier.js repo is archived; bindings now live in the main repo) | The default choice: wasm, with a built-in KinematicCharacterController. |
| @react-three/rapier | pmndrs/react-three-rapier | MIT | 2.2.0 (2025-11) | R3F binding. Releases have slowed. |
| JoltPhysics.js | github.com/jrouwe/JoltPhysics.js | MIT | **1.1.1 (2026-10-23)** | AAA-grade, with good vehicles and CharacterVirtual. |
| cannon-es | pmndrs/cannon-es | MIT | 0.20.0 (2022) | Stale. Avoid. |
| ecctrl | github.com/pmndrs/ecctrl | MIT | 2.0.2 | Floating-capsule character controller (R3F + Rapier). |
| Koota | github.com/pmndrs/koota | ISC | 0.6.6 | Modern ECS. Works with React or vanilla. |
| bitECS | NateTheGreatt/bitECS | MPL-2.0 | 0.4.0 | Fastest SoA ECS. |
| miniplex | hmans/miniplex | MIT | 2.0.0 (2023) | Stalled. |
| yuka | github.com/Mugen87/yuka | MIT | 0.7.8 | Steering and FSM for NPC students and cyclists. |
| **recast-navigation-js** | github.com/isaac-mason/recast-navigation-js | MIT | **0.44.0 (2026-10-30)** | Navmesh plus crowd simulation for pedestrians. |
| three-mesh-bvh | github.com/gkjohnson/three-mesh-bvh | MIT | 0.9.17 | Fast raycasts and picking on merged city meshes. |

## 5. Multiplayer / social (leuven.social)
| Name | URL | License | Status | Why for us |
|---|---|---|---|---|
| **Colyseus** | github.com/colyseus/colyseus | MIT | 0.18 (server 0.18.10) | Authoritative rooms with schema delta sync. Self-hosted on Node or Bun. |
| PartyServer / partysocket | github.com/cloudflare/partykit | ISC/MIT | 0.5.10 / 1.3.0 | One Durable Object per room, e.g. per neighbourhood. Ties us to Cloudflare. |
| **Yjs** | github.com/yjs/yjs | MIT | 13.6.33; v14 RC | CRDT for shared persistent state: pins, graffiti, notes. |
| Nakama | heroiclabs/nakama | Apache-2.0 | v3.41.0 | Full backend: accounts, friends, leaderboards. Its JS client is old. |
| geckos.io | geckosio/geckos.io | BSD-3 | 3.1.0 | UDP-like WebRTC. Niche. |
| Trystero | github.com/dmotz/trystero | MIT | 0.26.0 | Serverless P2P. Good for prototypes and proximity voice. |
| Jazz | garden-co/jazz | MIT | 2.0 alpha | Local-first DB. Its API is churning, so watch it rather than build on it. |
| Playroom Kit | joinplayroom.com | **proprietary** | – | Avoid. |

## 6. UI / HUD / audio
| Name | URL | License | Status | Why for us |
|---|---|---|---|---|
| lil-gui | georgealways/lil-gui | MIT | 0.21.0 | Dev tweaks. three also ships an Inspector for WebGPU. |
| Tweakpane / Leva | cocopon/tweakpane · pmndrs/leva | MIT | 4.0.5 / 0.10.1 | Debug panels. Slow release cadence. |
| uikit | github.com/pmndrs/uikit | MIT | 1.0.78 | In-world flexbox 3D UI (shop signs, panels). Vanilla and R3F. |
| Theatre.js | theatre-js/theatre | Apache-2.0 | 0.7.2 (2024) | Stalled. |
| HTML/CSS overlays | – | – | – | Best for chat, menus and a pixel-font HUD; slop-newyork does this. |
| Howler.js | goldfire/howler.js | MIT | 2.2.4 (2023) | Stable but unmaintained. |
| Tone.js | Tonejs/Tone.js | MIT | 15.x | Procedural or chiptune music, carillon bells. |
| WebAudio, hand-rolled | – | – | – | slop-newyork synthesises all its audio procedurally (`audio-synthesis.js`) with no samples. |

## 7. Assets and content tools
| Name | URL | License | Status | Why for us |
|---|---|---|---|---|
| Blender | blender.org | GPL | 5.2 LTS | Landmark modelling and glTF export. |
| **Blockbench** | JannisX11/blockbench | GPL-3.0 | v5.2.2 | Low-poly or boxy models with pixel textures and glTF export. Ideal for the cartoon/pixel look. |
| Goxel | guillaumechereau/goxel | GPL-3.0 | 0.15.1 | FOSS voxel editor (MagicaVoxel is freeware, not FOSS). |
| Kenney / Quaternius / KayKit | kenney.nl · quaternius.com · kaylousberg.itch.io | CC0 *(KayKit paid packs differ)* | active | Low-poly city kits, characters and vehicles. |
| Poly Pizza | poly.pizza | CC0 / CC-BY mix | – | Check each model's licence. |
| Mixamo | mixamo.com | proprietary | – | Free rigging, but not FOSS. |
| **glTF-Transform** | donmccurdy/glTF-Transform | MIT | 4.5.1 | Asset pipeline CLI: dedup, weld, meshopt, KTX2, instancing. |
| gltfjsx | pmndrs/gltfjsx | MIT | 6.5.3 | glTF → JSX (option B). |
| meshoptimizer | zeux/meshoptimizer | MIT | v1.3 | Compression and LOD simplification. Preferred over Draco. |
| KTX-Software / Basis | KhronosGroup · BinomialLLC | Apache-2.0 | 4.4.2 / 2.50 | GPU textures. Pixel art may prefer tiny uncompressed atlases with nearest filtering. |
| Aseprite | aseprite/aseprite | **source-available, not FOSS** | 1.3.18 | – |
| LibreSprite | LibreSprite/LibreSprite | GPL-2.0 | v1.3 | FOSS fork of the last GPL Aseprite. |
| **Pixelorama** | Orama-Interactive/Pixelorama | MIT | v1.2.3 | FOSS pixel editor built on Godot. Recommended. |

## 8. Build and dev
| Name | URL | License | Status | Note |
|---|---|---|---|---|
| Vite | vitejs/vite | MIT | 8.3.5 | Dev server and bundler. |
| Bun | oven-sh/bun | MIT | 1.4.4 | Build scripts and the game server. Already installed on this machine. |
| TypeScript | microsoft/TypeScript | Apache-2.0 | 7.0.2 (native Go compiler) | – |
| zustand | pmndrs/zustand | MIT | 5.0.16 | Game and UI state. |
| Tauri | tauri-apps/tauri | MIT/Apache | 2.12 | Optional desktop wrapper. |

**WebGPU support, late 2026** (gpuweb wiki):

| Browser | Status |
|---|---|
| Chrome / Edge | 113+ on desktop; Android 121+; Linux partly from 144–147. |
| Firefox | Windows 141+; macOS 145+/147+; Linux Nightly only. |
| Safari | 26+ on macOS, iOS and iPadOS. |

So use `WebGPURenderer` and rely on its automatic WebGL2 fallback, as long as every custom effect is written in TSL.

## 9. Procedural generation
| Name | URL | License | Note |
|---|---|---|---|
| mxgmn/WaveFunctionCollapse | github.com/mxgmn/WaveFunctionCollapse | MIT | The canonical algorithm (C#). |
| kchapelier/wavefunctioncollapse | github.com/kchapelier/wavefunctioncollapse | MIT | JS port. Fine for façade, park or block filler. |
| three-wfc | npm | MIT | Experimental *(unverified)*. |
| Hand-rolled split grammar | – | – | A small TS grammar (floor → bay → window, gable type) driven by GRB height and OSM roof type is more controllable than WFC. Recommended. |

## Sources
- [GitHub GraphQL API and npm registry (live queries)](https://registry.npmjs.org)
- [gpuweb implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)
- [three.js releases](https://github.com/mrdoob/three.js/releases)
- [three.js WebGPURenderer manual](https://threejs.org/manual/en/webgpurenderer.html)
- [R3F releases](https://github.com/pmndrs/react-three-fiber/releases)
- [rapier.js migration notice](https://github.com/dimforge/rapier.js)
- [Needle FAQ](https://cloud.needle.tools/faq/is-needle-engine-free-can-it-be-used-for-commercial-projects)
- [Spark](https://github.com/sparkjsdev/spark)
- [Godot 4.7 web export docs](https://docs.godotengine.org/en/4.7/tutorials/export/exporting_for_web.html)
- [Blender 5.2](https://www.blender.org/releases/5-2/)
- [3D GRB](https://www.vlaanderen.be/digitaal-vlaanderen/onze-diensten-en-platformen/basiskaart-vlaanderen-grb/3d-grb)

**Unverified:**
- Bevy web backend details
- OSM2World glTF output
- Kenney/Quaternius/KayKit/Poly Pizza licence specifics
- Overture height coverage for Belgium
- three-wfc maturity
