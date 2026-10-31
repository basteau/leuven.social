# Rendering

The aim is a city that opens instantly and costs nothing while you look at it, on a mid-range phone as much as a desktop.

## How the scene is built

- **One draw call per layer.** The ground (slab, gardens, water, roads, squares) is one merged mesh, and so are all buildings, building outlines and trees (instanced). That's 6 draw calls in total, including the shadow pass.
- **Vertex colours instead of textures.** Every face carries its colour from `palette.ts`. Two toon materials share one 3-step gradient: a plain one for ground and trees, and the facade material for buildings. Outlines use a `LineBasicMaterial`.
- **Flat shading on purpose.** `MeshBuilder` writes one normal per triangle and flips each triangle to face an outward hint, so winding mistakes can't happen.
- **Landmarks in the same draw call.** Hero landmarks (`landmark-models.ts`) are a handful of halls, towers and spires, keyed by GRB building id and fitted to the LiDAR in the footprint's own frame (u along its long side, v across). Their footprint is extruded to a low `base` and the parts go on top, so no polygon clipping is needed. Parts that form an outer wall stick out ~0.4 m past the footprint, so the base never z-fights with them. `landmark-models.test.ts` fails if a rebake drops or reshapes one of their footprints. Stepped gables and café parasols ride in the same mesh too.
- **Detail in the shader, not in geometry.** Windows are drawn by `facade-material.ts` from world position, with one row per 3.2 m floor and a few lit by the low sun. Walls carry their top height in a `facade` attribute. When a window is smaller than a game pixel, it fades to an average tint instead of shimmering. This adds no triangles.
- **Render on demand.** Nothing renders unless the camera or the view changes, so an idle map uses no GPU.
- **Static shadows.** The shadow map renders once, because the city doesn't move.
- **The pixel look is the cheapest look.**
  - The canvas renders at a fraction of the screen resolution, at least 2× game pixels, about 420 rows on a desktop window. CSS scales it up with `image-rendering: pixelated`.
  - The camera snaps to whole game pixels, so edges don't shimmer while panning.
  - Pixel mode draws 4–9× fewer pixels than the crisp mode.

## Budgets

The size and render budgets are enforced by `bun run verify`; if one is exceeded, the run fails:

| What                                   | Limit  | Checked by          |
| -------------------------------------- | ------ | ------------------- |
| App shell JS (React + HUD), gzipped    | 90 KB  | `scripts/budget.ts` |
| 3D engine JS (three.js chunk), gzipped | 170 KB | `scripts/budget.ts` |
| All JS, gzipped                        | 250 KB | `scripts/budget.ts` |
| CSS, gzipped                           | 6 KB   | `scripts/budget.ts` |
| City data                              | 300 KB | `scripts/budget.ts` |
| Draw calls per frame                   | 12     | `scripts/smoke.ts`  |
| Triangles per frame                    | 600k   | `scripts/smoke.ts`  |
| Console errors and warnings            | 0      | `scripts/smoke.ts`  |

The three.js chunk loads in parallel with the city data, so the HUD paints before the engine arrives.

## Growing the city

The research plan (REPORT.md §2) has three detail tiers, and each building already carries one:

- **hero:** hand-fitted landmarks (Stadhuis, Sint-Pieterskerk, Universiteitsbibliotheek so far) and the most stepped gables.
- **core:** procedural Flemish houses with gables.
- **fringe:** plain blocks.

When the map grows past the ring:

- Split meshes into ~250 m cells so frustum culling works.
- Keep fringe buildings out of the shadow pass.

Run the smoke test after each step and watch the numbers.

WebGPU and TSL post-processing (outlines, palette quantisation, dithering) are the next step for the look. Move to `WebGPURenderer` only when an effect needs it, and keep the smoke budgets green.
