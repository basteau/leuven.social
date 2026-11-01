# Rendering

The aim is a city that opens instantly and costs nothing while you look at it, on a mid-range phone as much as a desktop.

## How the scene is built

- **Cells, and only what's on screen.** The city is cut into 350 m cells (`cells.ts`). Everything in a cell (slab, ground layers and paths, buildings, trees, parasols) is one merged mesh, and its outlines are one `LineSegments`: two draw calls per cell. The viewer culls cells by their real bounding boxes (three's bounding spheres are far looser), so a frame costs what's in view, not what the city holds. Zoomed in, that's a tenth of the city.
- **Build what's seen first.** Cells in view, and those casting shadows into it, are built for the first frame; the rest are built in 8 ms slices while the page is idle (`requestIdleCallback`). The first paint costs what the visible part costs.
- **Vertex colours instead of textures.** Every face carries its colour from `palette.ts`. One toon material with a 3-step gradient draws every cell; ground and trees carry no facade, so they get no windows. Outlines use a `LineBasicMaterial`.
- **Flat shading on purpose.** `MeshBuilder` writes one normal per triangle and flips each triangle to face an outward hint, so winding mistakes can't happen.
- **Landmarks in the same draw call.** Hero landmarks (`landmark-models.ts`) are a handful of halls, towers and spires, keyed by GRB building id and fitted to the LiDAR in the footprint's own frame (u along its long side, v across). Their footprint is extruded to a low `base` and the parts go on top, so no polygon clipping is needed. Parts that form an outer wall stick out ~0.4 m past the footprint, so the base never z-fights with them. `landmark-models.test.ts` fails if a rebake drops or reshapes one of their footprints. Stepped gables and café parasols ride in the same mesh too.
- **Roofs from the survey.** Near-rectangles get gables. Every other footprint gets a hipped roof over its straight skeleton (`src/data/skeleton.ts`), which follows wings and courtyards for a handful of triangles per face and flattens off on wide blocks. Footprints are simplified to 25 cm first; the few the skeleton can't resolve (3 in 2556 around Grote Markt) fall back to flat.
- **Street furniture only up close.** About 4,600 lamps, benches, bike racks, bus stops, statues, fountains and pumps from OpenStreetMap (`src/data/props.ts`), a few boxes and panels each (`src/scene/props.ts`), drawn 1.3× life size so a lamp post is more than a hairline. Each cell's furniture is one more mesh with the same material, shown from zoom 2 (`PROP_ZOOM` in `viewer.ts`): further out a lamp post is a stray pixel and the frame is already the heaviest. Crossing that zoom refits and redraws the shadow map, so their shadows come and go with them. Tall ones (the Totem's needle) ride in the cell's main mesh and show at every zoom.
- **Bridges and tanks are walls.** Bridge parapets (low walls along the sides that face the water) and the brewery's tanks are extruded straight into the cell mesh with outlines, a few hundred triangles in all.
- **Trees grow to their surveyed height.** About 9600 of them: OSM's mapped trees plus LiDAR crowns of 10 m and up, spaced by crown size so canopies close with as few trees as possible. They cost 28 triangles each, drawn again in the shadow pass, which is what the shadow-frame cap pays for.
- **Detail in the shader, not in geometry.** Windows are drawn by `facade-material.ts` from world position, with one row per 3.2 m floor and a few lit by the low sun. Walls carry their top height in a `facade` attribute. When a window is smaller than a screen pixel, it fades to an average tint instead of shimmering. This adds no triangles.
- **Render on demand.** Nothing renders unless the camera or the view changes, so an idle map uses no GPU.
- **Static shadows, fitted to the view.** The city doesn't move, so the shadow map renders only on load and when the view leaves the square it covers (or zooms in far enough to deserve sharper shadows). The square is fitted to what's on screen, with 30% room to pan, a size stepped in 19% increments and a centre snapped to whole texels, so shadow edges don't swim when it moves (`shadow-fit.ts`). Its texels stay as small as the old whole-map shadows were at zoom 1 and get sharper zoomed in. On a frame that redraws it, the casting cells sit on the shadow camera's layer, so the shadow pass draws only them and the view only what's in view.
- **No hidden walls, no idle vertices.** A wall between two touching buildings is drawn only above the lower one (`partyWalls`). The bake drops footprint vertices within 0.25 m (0.5 m on the fringe) of the line through their neighbours; hero footprints keep theirs, as landmark models are fitted to them. Trees are a 4-sided open trunk and a 20-face crown, 28 triangles.
- **One rendering path.** The canvas renders at device resolution, capped at 2×. Only standard-density screens (below 1.5×) get multisampling; dense screens are smooth without it.

## Walking

Walk mode puts a figure on the streets (`character.ts`) and follows it with a perspective chase camera (`chase.ts`, glued in `walk.ts`): the one other camera, used only while walking. Every frame still goes through the viewer's one render path. It must hold 60 fps:

- **Walkability is built on demand.** `WalkGrid` (`src/data/walkable.ts`) rasterises roads, squares and paths at 1 m, minus building footprints, in 64 m tiles the first time something asks about them. A click costs one A* search (`route.ts`) inside a window around both ends, a few milliseconds, then string-pulling into a handful of straight legs.
- **The haze is the far clip.** Fog fades the city into the horizon colour from 90 m to 330 m beyond the walker, and the camera's far plane sits just past it, so the cells further out are culled. The fog is always in the scene (far off on the map) so walking never recompiles a shader. A sky dome (one call) fills the sky behind it.
- **Shadows don't follow the view.** From the street the shadow map covers a square around the walker (60 m plus the usual reach for tall roofs) whichever way the camera looks, so looking around never redraws it; it redraws only after walking out of it, every few dozen metres.
- **The camera's collision is a lookup.** The boom is checked in half-metre steps against the walk grid's building heights, a few dozen lookups per frame.
- **Two draw calls for the figure.** It's a few boxes on a twelve-bone `SkinnedMesh`. The ink outline is an inverted hull in the same geometry, and the blob shadow is dithered by the shader instead of blended, so figure, outline and shadow are one call. Its x-ray twin, a checkerboard silhouette drawn only where a building hides it, is the second. The route hint is one more while a walk is under way; dots behind the walker drop off by moving its draw range.
- **Animate only while something moves.** The walk loop runs while the walker moves, turns or idles (four seconds after stopping, none with reduced motion), and while the camera flies, turns or eases. Then it stops, and the map is back to rendering on demand. Nothing is allocated per frame.
- **The figure doesn't cast into the static shadow map**, but it receives it, so it darkens in the shade of the houses it passes.

## Budgets

The size and render budgets are enforced by `bun run verify`; if one is exceeded, the run fails:

| What                                   | Limit  | Checked by          |
| -------------------------------------- | ------ | ------------------- |
| App shell JS (React + HUD), gzipped    | 90 KB  | `scripts/budget.ts` |
| 3D engine JS (three.js chunk), gzipped | 170 KB | `scripts/budget.ts` |
| All JS, gzipped                        | 250 KB | `scripts/budget.ts` |
| CSS, gzipped                           | 6 KB   | `scripts/budget.ts` |
| City data                              | 1 MB   | `scripts/budget.ts` |
| Draw calls per frame                   | 100    | `scripts/smoke.ts`  |
| Triangles per frame                    | 600k   | `scripts/smoke.ts`  |
| Triangles per shadow-redraw frame      | 800k   | `scripts/smoke.ts`  |
| Console errors and warnings            | 0      | `scripts/smoke.ts`  |

Shadow-redraw frames draw the casting cells a second time, but happen only on load and when the view leaves the shadow square, so they get their own cap; every other frame keeps 600k.

The three.js chunk loads in parallel with the city data, so the HUD paints before the engine arrives.

The smoke test checks the first frame (which also draws the shadow map) and the latest frame at every step: default view, after the controls, zoomed in, zoomed all the way out, walking a few steps, back on the map, and on a phone. Each visible cell is two draw calls (three from zoom 2, with its furniture), and a frame that redraws shadows adds one or two per casting cell; draw calls are cheap here because every cell shares one material and program, so the budget watches triangles first. Typical numbers for the whole ring plus Heverlee: 34 calls and 184k triangles at the default view, 12 and 84k zoomed in, 92 and 385k zoomed out, 78 and 531k for the first frame, 14 and 80k walking.

## Growing the city

The research plan (REPORT.md §2) has three detail tiers, and each building already carries one:

- **hero:** hand-fitted landmarks (Stadhuis, Sint-Pieterskerk, Universiteitsbibliotheek, Station Leuven, Arenbergkasteel, the Abdij van Park church) and the most stepped gables. A landmark's footprint is listed in `LANDMARK_FOOTPRINTS` (`area.ts`), so the bake keeps it whole and in the hero tier.
- **core:** procedural Flemish houses with gables.
- **fringe:** plain blocks.

The map already covers the whole R23 ring and Heverlee. Growing it further:

- Zoomed out is the heaviest view. If it nears the budget, add a coarser level of detail for cells far from the centre of the screen, or raise the minimum zoom, before raising a budget.
- Fringe buildings could skip outlines, or the shadow pass, if they start to dominate.

Run the smoke test after each step and watch the numbers.

WebGPU and TSL post-processing (outlines, palette quantisation, dithering) are the next step for the look. Move to `WebGPURenderer` only when an effect needs it, and keep the smoke budgets green.
