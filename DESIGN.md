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
- **Roads say what they're made of.** Asphalt, setts and paving stones come from OSM, kerbs and cycle tracks from the GRB. Setts get a grain once a stone spans a pixel or two and joints once it spans a few; from afar they're just a warmer, lighter grey than asphalt and a greyer one than the squares.
- **Paint is at least a pixel, or nothing.** Lane lines are never thinner than a pixel, and go only when zoomed far out; zebra bars appear once a bar spans about two pixels, and before that the crossing is a light grey patch.
- **Streets have furniture.** From zoom 2, the lamps, benches, bike racks, bus shelters and statues OpenStreetMap knows, drawn a third larger than life so they stay a few pixels. Below zoom 2 they would be noise, so they hide. Jan Fabre's Totem on Ladeuzeplein (a 23 m needle with its jewel beetle) shows at every zoom.
- To add a landmark, fit parts in `src/scene/landmark-models.ts` against a LiDAR height plot of its footprint, list the footprint in `LANDMARK_FOOTPRINTS` (`src/data/area.ts`), rebake, then check it from all four rotations.

### Walking

- **A Leuven student**, a little larger than life (1.3×, like the street furniture): a coat in the HUD's accent blue, a mustard scarf, a brick-red backpack. Boxy, outlined in ink, toon-shaded like the city, with knees and elbows so they can run.
- **A street-level chase camera**, the way third-person games do it: the camera flies down from the map to just behind the walker, then rides a boom behind them. Drag to look around, scroll or pinch to bring it closer or further; it pulls in rather than look through a house. The far city fades into the warm haze of the map's horizon under a sky dome in the HUD's sky colours. Leaving flies back up to the nearest of the map's four views.
- **Walk or run.** Shift (or the **Run** toggle, or a thumb pushed to the stick's rim) runs. The figure turns on the spot or in an arc, never skids, and leans into curves; its head turns toward where the camera looks.
- **Walkable** means road surfaces, squares and footpaths. Never inside buildings or their courtyards, gardens, green or water without a path across.
- **Hidden behind a building**, the figure shows as a checkerboard silhouette in coat blue.
- **A picked destination** gets ink-ringed pale dots along the way and a square target, Street View style.

### Railways

- **Tracks read at every zoom, detail arrives as you zoom in.** Far out, a track is a light band (running lines) or a brown one (yards). As pixels get smaller than 0.9 m the catenary masts appear, under 0.5 m both rails as ink lines, and at the closest zoom the sleepers.
- **Masts only where they'd stand.** Every 60 m along electrified running lines, on the side with room, so a yard's inner tracks stay clear.
- **The station is the wave roof.** Leuven's platform roof is the most recognisable thing from above: four white vaults across the tracks, rising from the valleys to the crowns at their real LiDAR heights. Railway land is gravel, never lawn.
- **Not walkable:** tracks, railway land and platforms. Platforms are raised to train-floor height and the walker stays at street level; roads under rail bridges stay walkable.
- Tunnels and covered tracks aren't drawn. Bridges get a parapet on each open side; the ground is flat, so roads just pass underneath.

### Palette

Values live in `src/scene/palette.ts`; change them there only. Each building's colour is picked deterministically from its id, so it never changes between reloads.

| Element                | Colours                                                                                                                                                                                                   | Why                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| House walls            | Red, dark brown and yellow brick, whitewash and warm plaster creams, each house nudged a little lighter, darker, warmer or cooler by its id                                                               | Leuven's streets: red-brown brick next to whitewashed and pastel fronts, never two identical houses in a row                    |
| Civic and church walls | Sandstone and limestone                                                                                                                                                                                   | The Gothic Stadhuis, Sint-Pieterskerk and the university halls                                                                  |
| Landmarks              | Warm sandstone, pale limestone, red brick with cream trim, dark slate spires                                                                                                                              | Each hero is the lightest, most colourful building in its street                                                                |
| Café parasols          | Cream, brick red, mustard, orange, blue                                                                                                                                                                   | A few warm dots of life on the squares                                                                                          |
| Pitched roofs          | Their real colour from the air, snapped to eight swatches: dark slate, slate, zinc, pale concrete, old dark red tiles, red tiles, terracotta, moss                                                        | Leuven is mostly slate with red tiles between; the aerial photo knows which is which                                            |
| Flat roofs             | Cool greys, a step darker than plaster walls, picked by the same swatches                                                                                                                                 | Quiet backdrop that still separates a roof from its walls; never darker than the streets                                        |
| Paths                  | Pale slabs when paved, sand for gravel trails                                                                                                                                                             | Parks and the Dijle walks read as places to walk, not as roads                                                                  |
| Street furniture       | Iron-dark lamp posts with warm lanterns, wood benches, glass bus shelters, bronze statues on pale stone, bikes in the colours Leuven rides                                                                | Lamps, benches and full bike racks are what make a street read as Leuven's up close; they hide when zoomed out                  |
| Bridges and tanks      | Warm quay-stone parapets, pale aluminium tanks                                                                                                                                                            | A bridge reads as one by its parapets; the brewery by its tanks                                                                 |
| Railways               | Grey ballast under pale concrete sleepers on running lines, rusty ballast and dark timber in the yards, ink rails and catenary masts, pale concrete platforms, gravel railway land, a white platform roof | Leuven's railway is a wide band through the east of the city; it should read as tracks from any zoom without turning into noise |
| Trees                  | One low-poly tree, scaled to the LiDAR height of each one; each its own green (a little lighter or darker, yellower or bluer) and crown width, the tallest darkest                                        | Parks and gardens are as wooded as they really are, and read as many trees, not one stamp                                       |
| Windows                | Deep blue-grey glass, ~7% lit warm (`#f3c873`); each building its own bay width, window width and storey height from its real height                                                                      | The sun catching a few panes; rows that end under the eaves, and no two blocks with the same grid                               |
| Shop fronts            | A glazed ground floor under awnings (red, green, blue, mustard, brown, cream) where OSM maps a shop, café, bar or restaurant inside                                                                       | Shopping streets and squares read as lively at street level                                                                     |
| Ground                 | Garden green-beige base, lawn green, a deeper green under woods, bright mown pitches, asphalt car parks, golden sand cobbles for squares, river blue                                                      | Squares should glow slightly against the roads; parks show where the woods and the playing fields are                           |
| Roads                  | Pale slab pavements; asphalt carriageways, darker on the ring and main roads; warm grey setts; pale stone paving; red cycle tracks                                                                        | Leuven from the air: pale pavements frame dark asphalt, the old centre is stone, Flemish cycle tracks are red                   |
| Road paint             | Off-white lane lines and zebras; a zebra's average grey from afar; red cyclist crossings                                                                                                                  | The ring reads as a boulevard, and paint never shimmers                                                                         |
| Diorama slab           | Earth brown sides, inked along the top and bottom edges and down the corners                                                                                                                              | Frames the city as one object, drawn like the buildings on it                                                                   |
| Outlines               | `#2b2420` warm ink                                                                                                                                                                                        | Ties scene and HUD together (same ink as the panels)                                                                            |
| Walker                 | Coat `#2f62a8`, scarf `#e8b94a`, backpack `#b84c36`, hair `#7a4a2c`                                                                                                                                       | Reads against grey streets, sandy squares and green parks; the coat matches the HUD                                             |

## HUD

The HUD is a frame round the city: a corner at the top start, the credits at the top end, a rail of map controls at the bottom end and the mode's one or two actions in the middle of the bottom edge. The middle of the screen stays city.

### Tokens

Tokens are oklch, in `src/app/app.css`:

| Token                        | Use                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `--ink`                      | Text, borders, hard shadows. Same family as the scene outlines.                                                                                |
| `--paper`, `--paper-press`   | Panel and control fill, a warm cream; pressed and hovered                                                                                      |
| `--accent`, `--accent-press` | KU Leuven-ish blue (the walker's coat): the mode's primary action and a toggle that's on                                                       |
| `--sign`                     | The street plate: the accent's hue a shade deeper. Deeper shades are set by lightness, never mixed with ink, which would turn the blue purple. |
| `--control`, `--control-big` | 44 px round controls; 60 px for Run                                                                                                            |
| `--radius`, `--radius-inner` | 14 px panels; 10 px for what sits inside one, concentric                                                                                       |
| `--lift`, `--shadow-hard`    | The 3 px hard shadow every control stands on, and the 1 px one it sinks to when pressed                                                        |
| `--gutter`                   | Edge spacing, 12–20 px with the screen, plus the safe-area insets                                                                              |

### Surfaces

- 2 px ink border and a **hard 3 px drop shadow** with no blur: a nod to pixel UI that needs no transparency.
- **Pills** for actions and the brand, **circles** for map controls, a 14 px radius (`--radius`) for panels (the walking corner, the loading and error notice, hints). Things that belong together share one outline: the rail's controls one capsule split by a hairline, the walking corner one panel. What sits inside a panel is 2 px in from its 2 px border, with 10 px corners (`--radius-inner`), so they stay concentric.
- Inner radii are concentric (outer radius minus padding).

### Type

- System UI font, no web fonts, so nothing to download and no layout shift.
- Weights 600–800, sizes from 0.625 rem (credits) to 1.125 rem (the brand).
- Shortcut hints are monospace keycaps.

### Controls

- **Actions** are pills with an icon and a visible name: the one or two things a mode is for. The primary one is filled with the accent. The shortcut shows as a keycap on devices that have hover.
- **Map controls** are round, icon only, in a rail at the bottom end, the same place in every mode and in reach of a right thumb: a **compass** whose needle points north on the map and resets the view (R); **zoom in / zoom out** (+ / −; closer and further while walking), so pinch is never the only way to zoom; **turn left / turn right** (Q / E). Each has an accessible name, and shows it with its key as a tip on hover and keyboard focus.
- Every control is at least 44 px. On narrow screens the rail stands above the actions; on wide ones they share the bottom row.
- **Map:** the brand in the corner, the rail, and **Walk** (W) as the primary action. Walking downloads on first use; if that takes over a quarter of a second, the hint says "Getting ready to walk…", and if it fails, "Walking couldn’t load. Check your connection and try again."
- **Picking a start:** a reticle in the middle of the view, a hint ("Click a street to start there, or press Enter for the middle." / "Tap a street, or move the map and tap Start here."), and **Cancel** (Esc) / **Start here** (Enter).
- **Walking:** the corner is one panel, 48 px tall like the actions: a bare **Map** button (Esc) and the street plate beside it. The rail turns and zooms the camera, with **Run** under it: a big round toggle, filled while on, labelled, under the right thumb.
- **On touch,** a thumb that lands on the left of the screen grows a stick under it (ink ring, paper knob) and steers; anywhere else it looks around. Pushed to the rim, the stick runs.
- A spot that can't be walked to says so in the hint ("Can’t walk there. Pick a street or square.") until the next try.

### The street plate

- **Only while walking**, and only when the walker is on a named square or within 20 m of a named street. Names are OpenStreetMap's (`src/data/streets.ts`): a square wins over the streets round it, and at a corner the street already on the plate stays until another is 4 m closer, so it doesn't flicker.
- **An enamel plate inset in the corner panel,** beside the Map button: accent-blue (`--sign`) under a paper rim, paper text, 14 px, centred, two balanced lines at most (up to 17 rem wide). It has no border or shadow of its own: the panel's ink outline and hard shadow hold both, so it reads as part of the HUD, and never sits in the middle of the view. The Map button keeps its size; a long name wraps instead.
- It slides in from the Map button's side, and each new name slides in after it (240–300 ms ease-out); with reduced motion, names only fade.
- It's a polite live region ("On Brusselsestraat"), so screen readers hear each new street once.

### Hints and coaching

- One line, in a paper panel above the actions, always in the page (empty when there's nothing to say) so screen readers hear it change. It lets taps through to the map.
- **The first walk** is coached: keycaps (W A S D, Shift, drag, click) where there's a fine pointer; "Left thumb walks, right thumb looks" and a dashed ghost of the stick where the left thumb goes on touch. It stays until four seconds after the first step, and isn't shown again on that device (`localStorage`; if storage is blocked, it shows each walk). Everything it teaches is also on the controls' tips and in the map's description.

### States

| State    | Treatment                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Loading  | A small centred panel ("Building Leuven…") in one persistent `<output>` that also carries errors. Controls are disabled until ready. |
| Error    | A centred panel with a plain-language cause and a **Try again** button. Never a blank screen.                                        |
| Selected | Accent fill, with `aria-pressed`.                                                                                                    |
| Pressed  | The control sinks into its shadow (2 px down, 1 px shadow) and darkens; in a capsule, its icon shrinks a little.                     |

### Credits

- The data licences (ODbL for OpenStreetMap, GRB terms) require visible credit. OSM's attribution guidelines allow it to collapse only after it was shown.
- It sits in the top-end corner: "© OpenStreetMap" and "© Digitaal Vlaanderen" as two 10 px linked lines with a paper halo, beside (or, on narrow headers, under) a 20 px © button with a 44 px hit area.
- It collapses to just the © after 5 seconds or on the first pan, zoom or click; the © brings it back. The smoke test fails if the credit isn't visible at start.

### No labels on the map

Places aren't named over the city: floating tags covered the very streets they named and fought each other for room. The street plate names where you are while walking; the map has a text description for screen readers.

### Keyboard

- The map is one focusable widget (`role="application"`, focused on load without a ring).
- Arrow keys pan, `+`/`-` zoom, Q/E turn, R resets, W starts a walk. M mutes or unmutes, in every mode.
- Picking a start: Enter starts in the middle of the view, Escape cancels.
- Walking: W A S D or the arrow keys walk relative to the screen, Shift runs, holding Q/E turns the view, `+`/`-` bring the camera closer or further, Escape returns to the map. Clicking or tapping a street walks there along a route, shown as a quiet trail of small dots that shrink toward a thin ring. On the move the camera drifts back behind the walker a moment after the last look around.
- Shortcuts only act while focus is inside the app.

## Motion

- **Rotation:** 280 ms ease-out. Instant with `prefers-reduced-motion`.
- **Press feedback:** the control sinks into its hard shadow over 120 ms ease-out.
- **The street plate:** slides in from the side (240 ms), each new name after it (300 ms). With `prefers-reduced-motion` names only fade.
- **Hover:** only on devices with hover. Nothing else in the HUD animates; the compass needle turns with the view, frame by frame.
- **Walking and running:** a procedural cycle that blends from walk to run with speed. Legs and arms swing against each other, each knee folds as its leg swings through, the hips sit as high as the planted leg reaches so the soles stay down; running lengthens the stride, bends the elbows and leans in. The torso banks into turns and the head follows the camera. Standing still, the walker breathes and glances about for four seconds, then rests.
- **The camera** flies between the map and the street in 1.4 s, its lens widening as it closes in so the first frame matches the isometric map. It follows on springs: its look point trails the walker by a hair and leads it a little at a run, the lens widens slightly and the boom lengthens when running, and walls pull it in quickly but smoothly (docs/RENDERING.md, "How walking should feel"). With `prefers-reduced-motion` it cuts instead of flying, follows without easing and doesn't recentre; the figure appears without its pop and doesn't fidget. The walk cycle itself stays, since the user is moving the figure.
- **Future motion:** anything new (traffic, people, day-night) goes through Emil Kowalski's animation skills. It must also respect reduced motion.

## Sound

A tiny city sounds like a toy: felt and soft wood, never game-show beeps. Sounds are few, quiet, and made on the spot with Web Audio (`src/audio`), so there is nothing to download.

| Event                | Sound                                                                                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HUD button           | A soft wooden knock: a short falling triangle tone, low-passed, under a 12 ms stick of noise                                                                                                                                                                               |
| Toggle (Run)         | Two felted notes a fifth apart, rising for on, falling for off                                                                                                                                                                                                             |
| Footsteps            | Each time a foot lands in the walk cycle: a heel thump, a triangle at ~150 Hz gliding down an octave, under a scuff of band-passed grit. Every step is a little different in pitch, level and timing, the right foot a touch lower; a run lands higher, harder and quicker |
| Walk starts and ends | The flight's air (a noise band sweeping up or down) and two soft notes, rising going down to the street and falling coming back up                                                                                                                                         |
| Walking to a spot    | A quiet tick on setting off, a lighter pair of notes on arriving                                                                                                                                                                                                           |

- **On by default, never before a gesture.** The audio context is made on the first tap, click or key after sound is on, as browsers require.
- **Mute** (top start, or M) is a toggle that fills while muted, so the corner stays calm while sound plays. The choice is remembered.
- **Quiet:** a master level of 0.4 over voices of 0.03 to about 0.2, so even a running step peaks around a twelfth of full scale.
- **Silent while the tab is hidden,** and nothing plays per frame: each sound is scheduled when its event happens.
- Every voice rises over at least 3 ms and falls exponentially (no clicks), and passes through a filter: lowpass on tones for warmth, a band on noise. These follow Raphael Salaja's `create-sound` and `generating-sounds-with-ai` rules.
- No ambience loop: the city is quiet, and a loop would cost more than it gives.
- Surfaces don't change the step yet: the walk grid doesn't know cobbles from paving.

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
