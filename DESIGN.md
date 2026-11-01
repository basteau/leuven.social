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

### Landmarks and squares

- **Hero landmarks get their real silhouette.** Low-poly halls, towers and spires fitted to the LiDAR: the Stadhuis' steep roof with dormers and six turrets, Sint-Pieterskerk's cross, flèche and squat west work, the Universiteitsbibliotheek's tower, Station Leuven's gabled middle and pavilions, Arenbergkasteel's corner towers, the Abdij van Park church tower. Enough to recognise at zoom 2–4, never sculpted detail.
- **Stepped gables say "Flemish town".** Nearly half the gables in the hero squares are stepped, a fifth elsewhere in the centre, none on the fringe. Narrow gables stay plain, since the steps would be smaller than a game pixel.
- **Squares show what happens on them.** Oude Markt gets rows of café parasols along its facades; the middle stays open.
- **Streets have furniture.** From zoom 2, the lamps, benches, bike racks, bus shelters and statues OpenStreetMap knows, drawn a third larger than life so they stay a few pixels. Below zoom 2 they would be noise, so they hide. Jan Fabre's Totem on Ladeuzeplein (a 23 m needle with its jewel beetle) shows at every zoom.
- To add a landmark, fit parts in `src/scene/landmark-models.ts` against a LiDAR height plot of its footprint, list the footprint in `LANDMARK_FOOTPRINTS` (`src/data/area.ts`), rebake, then check it from all four rotations.

### Walking

- **A Leuven student**, a little larger than life (1.3×, like the street furniture): a coat in the HUD's accent blue, a mustard scarf, a brick-red backpack. Boxy, outlined in ink, toon-shaded like the city, with knees and elbows so they can run.
- **A street-level chase camera**, the way third-person games do it: the camera flies down from the map to just behind the walker, then rides a boom behind them. Drag to look around, scroll or pinch to bring it closer or further; it pulls in rather than look through a house. The far city fades into the warm haze of the map's horizon under a sky dome in the HUD's sky colours. Leaving flies back up to the nearest of the map's four views.
- **Walk or run.** Shift (or the **Run** toggle, or a thumb pushed to the stick's rim) runs. The figure turns on the spot or in an arc, never skids, and leans into curves; its head turns toward where the camera looks.
- **Walkable** means road surfaces, squares and footpaths. Never inside buildings or their courtyards, gardens, green or water without a path across.
- **Hidden behind a building**, the figure shows as a checkerboard silhouette in coat blue.
- **A picked destination** gets ink-ringed pale dots along the way and a square target, Street View style.

### Palette

Values live in `src/scene/palette.ts`; change them there only. Each building's colour is picked deterministically from its id, so it never changes between reloads.

| Element                | Colours                                                                                                                                    | Why                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| House walls            | Brick reds, warm plaster creams                                                                                                            | Leuven's streets: red-brown brick next to whitewashed and pastel fronts                                        |
| Civic and church walls | Sandstone and limestone                                                                                                                    | The Gothic Stadhuis, Sint-Pieterskerk and the university halls                                                 |
| Landmarks              | Warm sandstone, pale limestone, red brick with cream trim, dark slate spires                                                               | Each hero reads as its own building, a step darker and richer than the streets                                 |
| Café parasols          | Cream, brick red, mustard, orange, sage                                                                                                    | A few warm dots of life on the squares                                                                         |
| Pitched roofs          | Their real colour from the air, snapped to ten swatches: slate, black glazed and red tiles, terracotta, zinc, moss                         | Leuven is mostly slate with red tiles between; the aerial photo knows which is which                           |
| Flat roofs             | Light warm greys, picked by the same swatches                                                                                              | Read as quiet backdrop, never darker than the streets                                                          |
| Paths                  | Pale slabs when paved, sand for gravel trails                                                                                              | Parks and the Dijle walks read as places to walk, not as roads                                                 |
| Street furniture       | Iron-dark lamp posts with warm lanterns, wood benches, glass bus shelters, bronze statues on pale stone, bikes in the colours Leuven rides | Lamps, benches and full bike racks are what make a street read as Leuven's up close; they hide when zoomed out |
| Bridges and tanks      | Warm quay-stone parapets, pale aluminium tanks                                                                                             | A bridge reads as one by its parapets; the brewery by its tanks                                                |
| Trees                  | One low-poly tree, scaled to the LiDAR height of each one                                                                                  | Parks and gardens are as wooded as they really are                                                             |
| Windows                | Deep blue-grey glass, ~7% lit warm (`#f3c873`)                                                                                             | The sun catching a few panes; reads as life without noise                                                      |
| Ground                 | Garden green-beige base, warm grey roads, sand cobbles for squares, river blue                                                             | Squares should glow slightly against the roads                                                                 |
| Diorama slab           | Earth brown sides                                                                                                                          | Frames the city as an object                                                                                   |
| Outlines               | `#2b2420` warm ink                                                                                                                         | Ties scene and HUD together (same ink as the panels)                                                           |
| Walker                 | Coat `#2f62a8`, scarf `#e8b94a`, backpack `#b84c36`, hair `#7a4a2c`                                                                        | Reads against grey streets, sandy squares and green parks; the coat matches the HUD                            |

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
- **Walk** sits in its own panel beside the view toolbar and wraps above it when the row runs out. Picking a start shows a one-line hint, a reticle in the middle of the view, and **Start here** / **Cancel**. Walking swaps the toolbar for **Map** (back to the map view), **Run** (a toggle, filled while on), **Turn left** and **Turn right**, under a one-line hint: keys and the mouse on devices with a fine pointer, thumbs everywhere else.
- **On touch,** a thumb that lands on the left of the screen grows a stick under it (ink ring, paper knob) and steers; anywhere else it looks around. Pushed to the rim, the stick runs.
- A spot that can't be walked to says so in the hint ("Can’t walk there. Pick a street or square.") until the next try.

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
- Names and places come from OpenStreetMap; `LANDMARKS` only lists ids. Each shows from its own zoom. Landmarks and the big parks and sites show from the start, so the far view can be read across the whole map; churches and squares from zoom 1.5–2, small sights (the Totem) only up close.
- They're decorative: the map has a text description for screen readers.

### Keyboard

- The map is one focusable widget (`role="application"`, focused on load without a ring).
- Arrow keys pan, `+`/`-` zoom, Q/E turn, R resets, W starts a walk.
- Picking a start: Enter starts in the middle of the view, Escape cancels.
- Walking: W A S D or the arrow keys walk relative to the screen, Shift runs, holding Q/E turns the view, `+`/`-` bring the camera closer or further, Escape returns to the map. Clicking or tapping a street walks there along a route, and the camera swings round behind on the way.
- Shortcuts only act while focus is inside the app.

## Motion

- **Rotation:** 280 ms ease-out. Instant with `prefers-reduced-motion`.
- **Press feedback:** scale 0.97 over 140 ms ease-out.
- **Hover:** only on devices with hover. Nothing else animates.
- **Walking and running:** a procedural cycle that blends from walk to run with speed. Legs and arms swing against each other, each knee folds as its leg swings through, the hips sit as high as the planted leg reaches so the soles stay down; running lengthens the stride, bends the elbows and leans in. The torso banks into turns and the head follows the camera. Standing still, the walker breathes and glances about for four seconds, then rests.
- **The camera** flies between the map and the street in 1.4 s, its lens widening as it closes in so the first frame matches the isometric map. Its look point trails the walker by a hair. With `prefers-reduced-motion` it cuts instead of flying, follows without easing and doesn't swing behind on routes; the figure appears without its pop and doesn't fidget. The walk cycle itself stays, since the user is moving the figure.
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
