# Design

Leuven as a tiny city you could hold in your hands: a warm, crisp, low-poly diorama at golden hour, with a calm, game-like HUD that stays out of the way.

## Principles

1. **The city is the interface.** The map fills the screen. HUD panels are small, few, and float at the edges. Every new control has to justify covering the city.
2. **Recognisable, not literal.** Real footprints and real heights make it unmistakably Leuven. Simplified shapes and a limited palette make it charming. Spend detail where people look: hero landmarks first.
3. **Crisp over smooth.**
   - Hard shadows, a 3-step toon ramp, dark ink outlines.
   - No blur, no glows, no soft gradients inside the scene.
   - Smoothness belongs to motion, not to surfaces.
4. **Fast is a feature.** It opens instantly and costs nothing when idle. A visual idea that breaks a budget in docs/RENDERING.md needs a cheaper version.
5. **Works by hand and by thumb.** Everything works with mouse, touch and keyboard, from a 320 px phone to a desktop.

## Scene

### Camera

- True isometric view (35.26° pitch).
- Rotation snaps to 90° steps.
- One rendering path: device resolution (capped at 2×), with multisampling only on standard-density screens, where edges would otherwise stair-step.

### Light

- Golden hour: a warm sun (`#ffe2b8`) from the south-west, long shadows.
- A cool sky fill (`#cfe3ff`) and a warm ground bounce.
- Shade keeps its colour: a shadow is a darker, slightly richer version of the surface's own hue, not the sky's blue-grey, so sand in shadow still reads as sand next to sunlit asphalt (`src/scene/lighting.ts`; a test holds every ground colour to it).

### Landmarks and squares

- **Hero landmarks get their real silhouette.** Low-poly halls, towers and spires fitted to the LiDAR: the Stadhuis' steep roof with dormers and six turrets, Sint-Pieterskerk's cross, flèche and squat west work, the Universiteitsbibliotheek's tower, Station Leuven's gabled middle and pavilions, Arenbergkasteel's corner towers, the Abdij van Park church tower. Enough to recognise at zoom 2–4, never sculpted detail.
- **Stepped gables say "Flemish town".** Nearly half the gables in the hero squares are stepped, a fifth elsewhere in the centre, none on the fringe. Narrow gables stay plain, since the steps would be smaller than a game pixel.
- **Squares show what happens on them.** Oude Markt gets rows of café parasols along its facades; the middle stays open.
- To add a landmark, fit parts in `src/scene/landmark-models.ts` against a LiDAR height plot of its footprint, list the footprint in `LANDMARK_FOOTPRINTS` (`src/data/area.ts`), rebake, then check it from all four rotations.

### Palette

Values live in `src/scene/palette.ts`; change them there only. Each building's colour is picked deterministically from its id, so it never changes between reloads.

| Element                | Colours                                                                                                                                                            | Why                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| House walls            | Red, dark brown and yellow brick, whitewash and warm plaster creams, each house nudged a little lighter, darker, warmer or cooler by its id                        | Leuven's streets: red-brown brick next to whitewashed and pastel fronts, never two identical houses in a row |
| Civic and church walls | Sandstone and limestone                                                                                                                                            | The Gothic Stadhuis, Sint-Pieterskerk and the university halls                                               |
| Landmarks              | Warm sandstone, pale limestone, red brick with cream trim, dark slate spires                                                                                       | Each hero is the lightest, most colourful building in its street                                             |
| Café parasols          | Cream, brick red, mustard, orange, blue                                                                                                                            | A few warm dots of life on the squares                                                                       |
| Pitched roofs          | Their real colour from the air, snapped to eight swatches: dark slate, slate, zinc, pale concrete, old dark red tiles, red tiles, terracotta, moss                 | Leuven is mostly slate with red tiles between; the aerial photo knows which is which                         |
| Flat roofs             | Cool greys, a step darker than plaster walls, picked by the same swatches                                                                                          | Quiet backdrop that still separates a roof from its walls; never darker than the streets                     |
| Paths                  | Pale slabs when paved, sand for gravel trails                                                                                                                      | Parks and the Dijle walks read as places to walk, not as roads                                               |
| Trees                  | One low-poly tree, scaled to the LiDAR height of each one; each its own green (a little lighter or darker, yellower or bluer) and crown width, the tallest darkest | Parks and gardens are as wooded as they really are, and read as many trees, not one stamp                    |
| Windows                | Deep blue-grey glass, ~7% lit warm (`#f3c873`); each building its own bay width, window width and storey height from its real height                               | The sun catching a few panes; rows that end under the eaves, and no two blocks with the same grid            |
| Shop fronts            | A glazed ground floor under awnings (red, green, blue, mustard, brown, cream) where OSM maps a shop, café, bar or restaurant inside                                | Shopping streets and squares read as lively at street level                                                  |
| Ground                 | Garden green-beige base, warm grey roads, golden sand cobbles for squares, river blue                                                                              | Squares should glow slightly against the roads                                                               |
| Diorama slab           | Earth brown sides                                                                                                                                                  | Frames the city as an object                                                                                 |
| Outlines               | `#2b2420` warm ink                                                                                                                                                 | Ties scene and HUD together (same ink as the panels)                                                         |

## HUD

### Tokens

Tokens are oklch, in `src/app/app.css`:

| Token      | Use                                                             |
| ---------- | --------------------------------------------------------------- |
| `--ink`    | Text, borders, hard shadows. Same family as the scene outlines. |
| `--paper`  | Panel fill, a warm cream                                        |
| `--accent` | KU Leuven-ish blue, only for the selected state of a toggle     |

### Panels

- 2 px ink border, 8 px radius.
- A **hard 3 px drop shadow** with no blur. It's a nod to pixel UI and needs no transparency.
- Inner radii are concentric (outer radius minus padding).

### Type

- System UI font, no web fonts, so nothing to download and no layout shift.
- Weights 600–700 for controls, sizes from 0.625 rem (credits) to 1.25 rem (title).
- Shortcut hints use the monospace stack.

### Controls

- At least 44 px tall.
- Icon plus a visible text label.
- A keyboard shortcut is shown on devices that have hover.
- Below 30 rem of width the toolbar becomes a tab bar: icon above label, no shortcut hints.

### States

| State    | Treatment                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Loading  | A small centred panel ("Building Leuven…") in one persistent `<output>` that also carries errors. Controls are disabled until ready. |
| Error    | A centred panel with a plain-language cause and a **Try again** button. Never a blank screen.                                        |
| Selected | Accent fill, with `aria-pressed`.                                                                                                    |

### Credits

- The data licences (ODbL for OpenStreetMap, GRB terms) require visible credit. OSM's attribution guidelines allow it to collapse only after it was shown.
- It sits in the top-end corner, out of the layout flow, so it never pushes the HUD: "© OpenStreetMap" and "© Digitaal Vlaanderen" as two 10 px linked lines with a paper halo, beside (or, on narrow headers, under) a 20 px © button with a 44 px hit area.
- It collapses to just the © after 5 seconds or on the first pan, zoom or click; the © brings it back. The smoke test fails if the credit isn't visible at start.

### Labels on the map

- Small ink-bordered tags anchored above landmarks.
- Their order in `LANDMARKS` is their priority: a label that would overlap an earlier one, or cross the screen edge, is hidden.
- They're decorative: the map has a text description for screen readers.

### Keyboard

- The map is one focusable widget (`role="application"`, focused on load without a ring).
- Arrow keys pan, `+`/`-` zoom, Q/E turn, R resets.
- Shortcuts only act while focus is inside the app.

## Motion

- **Rotation:** 280 ms ease-out. Instant with `prefers-reduced-motion`.
- **Press feedback:** scale 0.97 over 140 ms ease-out.
- **Hover:** only on devices with hover. Nothing else animates.
- **Future motion:** anything new (traffic, people, day-night) goes through Emil Kowalski's animation skills. It must also respect reduced motion.

## Mobile and PWA

| Concern       | Rule                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Viewport      | `100dvh` app shell, `viewport-fit=cover`, safe-area insets on every edge-pinned panel                              |
| Overscroll    | No pull-to-refresh on the map                                                                                      |
| Tap highlight | None. Every control has its own `:active` state.                                                                   |
| Install       | Installable as a standalone app with a pixel-art stepped-gable icon                                                |
| Offline       | Works once loaded (service worker in production builds only)                                                       |
| Verification  | Check on a real phone before calling a touch change done. Emulation misses sticky hover, tap delay and safe areas. |

## Writing

- Short, plain and friendly.
- Use Dutch place names (Grote Markt, Oude Markt, Sint-Pieterskerk); the UI language is English.
- Errors say what happened and what to do next.
