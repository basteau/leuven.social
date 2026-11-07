# Migrating to one top-down camera

**Goal:** one camera, one avatar, no modes. The isometric diorama becomes the only view, from the
whole city down to a street and into a building, with interiors that can grow to several floors.

**Non-goals:** changing the city data, changing the look at the current zoom levels, adding runtime
dependencies, or making interiors for more than the authored landmark buildings.

Each phase below is shippable on its own and ends green (`bun run verify`). Nothing is left
half-migrated at a phase boundary.

---

## 1. Verified baseline

Measured on `main` before the migration:

| Module                                                | Lines         | Chunk               |
| ----------------------------------------------------- | ------------- | ------------------- |
| `walk.ts` (glue, steering, spawn, thumb stick)        | 1,255         | 20.5 KB gz          |
| `ride.ts`, `bike-rig.ts`, `rider-pose.ts`, `rider.ts` | 2,469         | 12 KB gz            |
| `chase.ts` (follow camera, flight, occlusion maths)   | 445           | in the engine chunk |
| `spawn.ts`, `plates.ts`, `streets.ts`                 | 147 + 477 + — | 5.8 + 1.5 KB gz     |
| Tests beside them                                     | ~5–6k         | —                   |

Facts the plan depends on, checked in the source:

- The map camera is an `OrthographicCamera` at `PITCH = atan(1/√2)` (35.26°), `VIEW_HEIGHT = 560`,
  `CAMERA_DISTANCE = 2000`, zoom clamped by `MapControls` to **0.5–4**. The walk camera is a
  separate `PerspectiveCamera` in `viewer.ts` (`street`), swapped in through `useView()`.
- Every level-of-detail decision is already keyed to one number, `viewSpan = VIEW_HEIGHT / zoom`:
  props at `span ≤ 280` (`VIEW_HEIGHT / PROP_ZOOM`), cells by frustum, the shadow square by span.
  A continuously zooming camera therefore inherits correct LOD with no new rules.
- Landmarks are **not** separate meshes. `buildings.ts` calls `addLandmark()` into the same cell
  mesh ("landmarks in the same draw call"), and `LANDMARK_FOOTPRINTS` in `area.ts` keeps their
  footprints whole. Un-merging them is a real change, not a switch (§3.5).
- `MeshBuilder` flips every triangle to face an outward `hint` (§3.4). Interior walls built with
  the existing path would be invisible from inside.
- `figure.ts` and `bike-rig.ts` are already shared with the traffic simulation, which draws people
  and cyclists as the same figure. The avatar becomes a third consumer, not the owner.
- `WalkGrid` is one 1 m raster built lazily from the city; `walk.bin` (96 KB budget) is the
  house-number and street-plate data, loaded with walk mode.

Budgets that must not be crossed (`scripts/smoke.ts`, `scripts/budget.ts`):

| Budget                                 | Limit             |
| -------------------------------------- | ----------------- |
| Draw calls per frame                   | 160               |
| Triangles per frame                    | 1,150,000         |
| Whole city vertices / geometry         | 3,300,000 / 80 MB |
| Longest main-thread task while loading | 150 ms            |
| First-load JS (closure)                | 257.5 KB gz       |

## 2. Target architecture

### 2.1 Camera

One orthographic camera, fixed true-isometric pitch, yaw in quarter turns (unchanged), and a zoom
range that reaches the street:

```ts
const VIEW_HEIGHT = 560; // metres tall at zoom 1 — unchanged
const MIN_ZOOM = 0.5; // whole city — unchanged
const MAX_ZOOM = 40; // ≈ 14 m tall: a street, three houses wide
```

- `span = VIEW_HEIGHT / camera.zoom` stays the single LOD input; no `street` branch, no `useView`.
- The camera only ever translates and changes `zoom`; `placeCamera()` keeps its shape, its target
  becomes the follow target.
- `PITCH` and `CAMERA_DISTANCE` are unchanged, so the art at existing zooms is untouched.
- Fog near/far become a function of `span` (one pure function), so street zoom draws haze nearer
  instead of relying on the walk mode's fog pull-in.

**LOD contract** (one table, in code, tested):

| `span` (m) | What is drawn                                                         |
| ---------- | --------------------------------------------------------------------- |
| > 400      | cells in view; city only                                              |
| 280–400    | + trees, monuments, traffic near the view                             |
| 60–280     | + street furniture, parked bikes, outlines                            |
| 20–60      | + facade plates (from `walk.bin`), house numbers, interiors prewarmed |
| < 20       | + avatar at full detail, interior floor meshes, room furniture        |

Below a span of ~120 m the avatar is drawn as a 2-triangle marker rather than the rigged figure; at
city zoom it is not drawn at all. This is a rendering rule, not a state change.

### 2.2 Avatar and input

One avatar exists from the first frame, spawned on Grote Markt. There is no map mode and no walk
mode; the map is the camera far from the avatar.

```ts
// src/scene/avatar.ts
export interface AvatarState {
  x: number;
  z: number;
  facing: number; // radians, from movement
  speed: number; // m/s, eased
  mode: 'foot' | 'bike';
  place: string | null; // room id, if inside
  floor: number; // 0 = street
}
```

This is the serialisable state. It lives in a plain object, is updated by pure step functions, and
is the exact shape a later multiplayer layer would send. Nothing about it references three.js.

Movement keeps the tested machinery: `walkable.ts` for where you may stand, `collide.ts` for
collide-and-slide, `route.ts`/`graph-route.ts` for click-to-walk. Speeds: foot 1.5 m/s, run 3.6,
bike 6–11 with momentum.

| Input                      | Action                                     |
| -------------------------- | ------------------------------------------ |
| Drag, arrows, pinch, wheel | Pan and zoom (unchanged)                   |
| W A S D                    | Move, relative to the current quarter view |
| Shift                      | Run                                        |
| Click / tap ground         | Route the avatar there                     |
| Q / E                      | Turn the view a quarter (unchanged)        |
| F / B                      | Take or leave a bike / ring the bell       |
| Esc                        | Recentre on the avatar                     |

The thumb-stick overlay is deleted: tap-to-walk already solves touch.

**One owner of input.** Today `MapControls` and walk mode both attach pointer handlers to the
canvas. After the migration exactly one pointer handler set (pan/pinch/wheel plus the existing tap
detection in `viewer.ts`) and one keyboard map (in `shortcuts.ts`) exist. Double-handling is a
correctness bug, not a style issue: it produces double zooms and swallowed taps.

### 2.3 Camera follow

The camera is never mounted on the avatar.

- Panning is always allowed and pauses follow.
- After 2 s without input, or on `recentre()`, the target eases to the avatar (reuse `decay` and
  `decayAngle` from `motion.ts`).
- The pure helpers worth keeping from `chase.ts` are `recentre`, `recentreWeight` and
  `followStrength`; they move to `src/scene/follow.ts` with their tests. Everything else in
  `chase.ts` is deleted.

### 2.4 Interiors

Interiors exist only for **authored landmark buildings** — the ones `LANDMARK_MODELS` already builds
specially. The other 16,000 buildings stay sealed. This keeps the silhouette and bounds the work.

Rules that make it correct and cheap:

- **Same world space.** Rooms sit inside the real footprint at real coordinates. No separate scene,
  no teleport, no loading screen.
- **No ceilings.** The floor above is hidden, so a ceiling is never seen. An interior is a floor
  slab, wall segments and furniture: 1–2k triangles per room.
- **Inward-facing shells.** Room walls are built with an inward `hint` (`MeshBuilder` already takes
  the hint per triangle). Never a double-sided material: it doubles the fragment work and breaks the
  ink outlines.
- **Per-floor meshes.** Each floor is its own mesh, so visibility is a boolean: active floor visible,
  floors above hidden. Each mesh carries its own bounding box for culling.
- **The floor below is drawn only where it can be seen** — through a stairwell or an atrium hole.
  A solid slab occludes it completely, so drawing it is wasted. Holes use the same inner-ring
  treatment `Building.holes` already has.
- **Floor height comes from the bake.** A room's ground floor sits at the building's foot
  (`MeshBuilder.foot`, `footing`), so there is no step at the door and the facade's storey lines
  still line up.

### 2.5 Floors and stairs

- Floors are `y` + `height`, not a fixed storey height: a nave is one 20 m volume, a house floor is
  3.2 m. Each floor has its own slab ring, walls, props and stair links.
- **Stairs are transition cells.** A stair cell in the floor grid carries no level; entering it
  drives the active floor and raises the avatar's `y` along the ramp. The floor switch happens where
  the seam cannot be seen. Collision ignores the stair's side edges.
- **Door thresholds belong to no grid.** The threshold cell is open in both the street grid and the
  room grid, so entering can never collide with the doorframe and `place` changes exactly once, at a
  cell boundary.

### 2.6 Room grids, not a fork of `WalkGrid`

`WalkGrid` is a 1 m raster built from city layers. Rooms need the same thing from authored rings.
Do not fork it: extract the raster (cell encode/decode, tile fill, `cellAt`, `centre`) into a small
`CellGrid` in `src/data`, and let `WalkGrid` and the new `RoomGrid` build on it. Same encoding, same
tests, one implementation.

### 2.7 Data

Authored, hand-editable, diffable, fetched lazily:

```ts
// public/data/rooms.json, keyed by GRB OIDN (stable across rebakes)
export interface Room {
  oidn: string;
  name: string;
  door: { x: number; z: number; facing: number };
  floors: Floor[];
}
export interface Floor {
  level: number;
  y: number; // metres above the building's foot
  height: number;
  slab: number[]; // ring, flat [x, z, …], world metres
  holes: number[][]; // stairwells and atriums
  walls: { x0: number; z0: number; x1: number; z1: number; gaps: [number, number][] }[];
  props: { kind: string; x: number; z: number; angle: number }[];
  stairs: { to: number; x: number; z: number; width: number; depth: number }[];
}
```

Validation is pure and tested in `src/data/rooms.ts`:

- the OIDN exists in `city.bin` and the footprint is a landmark footprint;
- every floor ring lies inside the footprint;
- the door lies on a wall with a gap;
- every stair links two floors that exist, and its cells are inside both slabs;
- no ring self-intersects.

A malformed room fails the build in `baked.test.ts`, not at runtime. At runtime, a failed fetch is a
user-facing `RoomLoadError` with a sentence, and the door simply does not open.

## 3. The two hard changes

### 3.1 Opening a landmark

Landmarks are merged into their cell. Two options were considered:

| Option                                          | Cost                                                                                             | Verdict                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Un-merge all 9 landmarks into standalone groups | +2–3 draw calls each (walls, roof, ink), worst case +27 calls zoomed out, and duplicate geometry | Rejected: it spends the frame budget on the common case to save nothing there |
| **Rebuild the cell with an `open` set**         | one cell rebuild (~a few ms) on entering, once                                                   | Chosen                                                                        |

Implementation: the cell builder already takes a deterministic set of buildings and can be re-run
(`build(entry)` exists). Add an `open: Set<number>` to the build input; when a landmark's roof is in
that set, `buildings.ts` skips the roof (and the walls above the room's ceiling) but keeps
everything else. `build(entry)` is called for that cell, the old buffers are released, and the
shadow map is redrawn once — the existing `missingCasters` path already handles "casters changed".

The hitch is the only risk. Mitigations, in order:

1. Prewarm: when the avatar comes within 60 m of a door and the page is idle
   (`requestIdleCallback`, as the cell builder already uses), build the open variant of that cell
   and keep both, discarding the other when the avatar leaves. Memory is bounded to one cell pair.
2. If the rebuild still shows, move that one landmark into a cell of its own at bake time.
3. Last resort: detach only the roof as a standalone mesh.

The gate is measurable: entering a room must not add more than 8 ms to the longest frame, checked
in the smoke test by the existing long-task counter.

### 3.2 Occlusion, top-down

At 35° a 10 m house across a 6 m street hides the avatar constantly. Three layers, all reused:

1. **Roof lift** for the building the avatar is in or directly behind — §3.1. No material change.
2. **Wall dither** for walls between camera and avatar: reuse `facade-material.ts`'s dither, its
   uniform fed by avatar distance in the view instead of lens distance. Dither, never alpha blending:
   blending needs sorting and costs overdraw across the whole screen.
3. **Silhouette x-ray** of the avatar behind a wall: already implemented; drive it from the avatar.

Deleted: the decollider, the camera pull-in, the near-lens fade, the sky dome.

## 4. Code organisation

| New or changed           | Layer | Shape                                                |
| ------------------------ | ----- | ---------------------------------------------------- |
| `src/data/cell-grid.ts`  | data  | Raster extracted from `walkable.ts`; pure, tested    |
| `src/data/rooms.ts`      | data  | Schema, validation, floor/stair lookup; pure, tested |
| `src/scene/avatar.ts`    | scene | State + step; movement, follow, floor ramp           |
| `src/scene/follow.ts`    | scene | The kept parts of `chase.ts`; pure maths             |
| `src/scene/room-mesh.ts` | scene | Builds a floor's slab, shells and props              |
| `src/scene/bikes.ts`     | scene | Take/leave, speed, bell; replaces `ride.ts`          |
| `src/app/*`              | app   | One label set, one shortcut map, room UI             |

Rules, all already enforced by the repo:

- Layers: `src/data` may not import three.js or React; `src/scene` may not import React.
- Pure first: every new rule above is a pure function with a test. `viewer.ts` stays thin glue.
- Named exports only, `import type` for types, strict nulls (`noUncheckedIndexedAccess`).
- Comments say why, not what.
- No new dependencies; Portable packages only.
- A deleted module deletes its test in the same commit, and `src/modules.test.ts` is updated, or
  coverage hides the gap.
- User-reachable errors carry a written message (`RoomLoadError`).

Suggested commit sequence, one logical change each:
`refactor(scene): one camera` → `refactor(scene): avatar replaces walk mode` →
`refactor(scene): bikes without a rig` → `feat(scene): open landmark roofs` →
`feat(data): rooms and floors` → `feat(scene): interiors` → `feat(app): rooms in the menu` →
`docs: top-down camera`.

## 5. Phases

### Phase 0 — Baseline (half a day)

Branch `top-down`, tag `pre-top-down`. Record `bun run verify` output, `.artifacts/` screenshots,
the budget table and frame times at zoom 0.5, 1, 2, 4. List the walk/ride tests.

**Done:** numbers written down, reproducible.

### Phase 1 — One camera (2–3 days)

Delete the `PerspectiveCamera`, `street`, `useView`, the walk branch of `viewSpan`, the near-lens
fade and the sky dome. Raise `maxZoom` to 40. Make fog a function of `span`. Everything else in
`walk.ts` keeps working, drawing with the orthographic camera.

**Done:** walking works top-down; `chase.ts` reduced to `follow.ts`; draw calls and triangles at
every zoom within the existing caps; screenshots reviewed at five zoom levels.

**Rollback:** the tag.

### Phase 2 — One avatar (2 days)

`walk.ts` → `avatar.ts`: movement, facing, speed, follow. Delete steering, look, thumb stick, flight
and `spawn.ts`'s dive, keeping the marker and dust as click feedback. Plates and the street sign
become span-driven. One input owner (§2.2).

**Done:** one control scheme on desktop and touch; `spawn.ts` gone; coverage ≥ 95%; smoke asserts
`data-place`.

### Phase 3 — Bikes without a rig (3–4 days)

Delete `ride.ts`, `rider-pose.ts`, `rider.ts` and `bike-rig.ts`'s camera-facing parts. New
`bikes.ts`: parked bikes from `city.props` (already there), take/leave in 0.6 s, speed profile,
bell. Reuse the existing bike mesh unchanged.

**Done:** riding is faster walking with a bell; the ride chunk is replaced by a smaller one; budgets
lowered in the same commit with the reason in the message.

### Phase 4 — Occlusion (2 days)

Avatar-driven dither and x-ray; roof-lift wiring (§3.1) in place but inert. Sweep the streets round
Grote Markt at maximum zoom and assert no obstruction longer than 250 ms within 60 m.

### Phase 5 — Interiors v1, one room (1 week)

`cell-grid.ts` and `rooms.ts` with tests; `room-mesh.ts`; door trigger; camera zoom clamped to 8–20
inside; Sint-Pieterskerk authored. Open-roof rebuild with idle prewarm. Enter and exit back to the
street.

**Done:** no visible hitch; the interior is drawn with inward shells and inked; smoke covers
enter/exit; the room's data is validated against `city.bin` by test.

### Phase 6 — Floors (1 week)

Floor stack, active-floor visibility, stair transition cells, one hole (a gallery in the church or
the library). A second floor authored.

**Done:** two-storey traversal with no popping at 120 Hz; `onFloorChange` drives the UI; draw calls
stay under the cap with a floor and its hole visible.

### Phase 7 — App, copy, docs (2–3 days)

One label set (delete "Walk here" and "Back to the map"), shortcuts, coach marks, screen-reader copy
(`mapLabels`/`rideLabel` in `App.tsx`). Update `docs/CODE.md`, `docs/RENDERING.md`, `DESIGN.md` and
this file.

**Done:** no stale mention of walk mode in UI or docs; `bun run verify` green.

### Phase 8 — Measure and polish (2 days)

Frame budget at every zoom on phone and desktop; screenshots in `.artifacts/`; footsteps and bell
retuned for the new camera.

## 6. Budgets after the migration

| Budget                  | Before       | Target after                                         |
| ----------------------- | ------------ | ---------------------------------------------------- |
| Walk mode chunk         | 20.5 KB      | —                                                    |
| Riding chunk            | 12 KB        | ~3 KB (`bikes`)                                      |
| Plates / streets chunks | 5.8 / 1.5 KB | unchanged size, new load trigger                     |
| App shell               | 85 KB        | +1–2 KB, then trimmed                                |
| Engine                  | 172.5 KB     | −2 to −3 KB (one camera, no sky dome, no decollider) |
| Rooms data              | —            | ≤ 80 KB, lazy                                        |
| Draw calls              | ≤ 160        | ≤ 160; interiors add ≤ 4 when inside                 |
| Triangles               | ≤ 1.15M      | unchanged at every existing zoom                     |

Lower a limit in the commit that earns it, never raise one to pass a phase.

## 7. Risk register

| Risk                                     | Mitigation                                                                         | Gate                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------ |
| Close-up orthographic looks like a model | Review at max zoom in Phase 1; fallback is a small pitch tilt at the closest stops | Screenshots              |
| 35° hides more than 45°                  | Phase 4 sweep; pitch may rise to 40° at max zoom if measured                       | Sweep must pass          |
| Cell rebuild hitch on entering           | Idle prewarm of the approaching cell; fallback to a standalone roof mesh           | Longest frame + ≤ 8 ms   |
| Interior walls invisible from inside     | Inward `hint` in `room-mesh.ts`; test that interior faces point inward             | Unit test                |
| Rooms drift from the bake                | OIDN keys, validation against `city.bin` in `baked.test.ts`                        | Build fails, not runtime |
| Coverage churn                           | Delete code and tests together; update `modules.test.ts`                           | 95% per file             |
| Loss of the animated walk/ride           | Keep the tag; the gait survives as the avatar's animation                          | —                        |

## 8. Decisions to settle before Phase 1

1. **Pitch:** fixed 35.26° (recommended; consistent art) or 35° far / 40–45° near (better occlusion,
   slight art drift). Decide by the Phase 4 sweep, not by taste.
2. **Avatar always present** (recommended; makes "no modes" true) or spawned on first click.
3. **Interior scope:** nine landmarks only (recommended) or a generic cutaway for any building.
4. **Interior palette:** reuse the facade palette (recommended; one look) or a warmer indoor palette.
