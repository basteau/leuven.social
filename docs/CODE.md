# Code

## Layers

The code is split by what it is allowed to know about. Lint enforces the arrows, so breaking one fails `bun run lint` with a message pointing here.

| Layer       | Holds                                                                               | May import                                                           |
| ----------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/data`  | The city model, the binary format, geometry and projection maths, the map area      | `@portable/*` and web APIs only. No three.js, React or other layers. |
| `src/scene` | Everything 3D: meshes, materials, camera, controls, the render loop                 | `src/data`, `src/audio`, three.js. No React.                         |
| `src/audio` | The few UI, walking and riding sounds, synthesised with Web Audio                   | Web APIs only. No three.js, React or other layers.                   |
| `src/app`   | The React shell: the command menu, the few things on the map, loading, shortcuts    | `src/data`, `src/scene`, `src/audio`                                 |
| `scripts/`  | Build-time edges: fetching and baking data, icons, budgets, the smoke test, deploys | `src/data`, plus the `Bun` global for files and processes            |

`src/scene` exposes one entry point, `createViewer()`. It returns a small imperative handle (`rotate` and `spin` for a held turn, `zoomBy`, `resetView`, the walk controls `preloadWalk`, `walkAt`, `walkAtScreen`, `walkFromCentre`, `steer`, `run`, `look` and `stopWalking`, `ride` for getting on and off a bike and its bell, `stats`, `dispose`, and `ready`, which settles once the first frame is drawn), so React never touches three.js objects. Walk mode is its own chunk, which the viewer imports the first time it's needed, with the street-name lookup (`src/data/streets.ts`) in a small chunk beside it. It reports back through callbacks: `onWalkModeChange`, `onWalkBlocked`, `onWalkUnavailable` when its download fails, `onStreetChange` with the street under the walker for the street plate, `onRideChange` when a bike is near or ridden, and `onHeading`, which way the view looks. Riding (`ride.ts`) is a chunk walk mode imports near a rack, taking its three.js classes and the figure's materials as a kit. The house numbers and street plates on the facades (`plates.ts`) are a second chunk, which the viewer imports with `walk.bin` once walk mode has loaded. Street furniture, monuments and the shop fronts' awnings, signs and terraces (`furniture.ts`, with `props.ts`, `monuments.ts` and `storefronts.ts`) are a third, which the viewer imports once its first frame is drawn; it also carries `drawnGround` (`drawn-ground.ts`), the ground as drawn, which walk mode stands the walker and the bikes on. A lazy chunk takes what it shares with the engine as a `kit` (three.js classes, `MeshBuilder`, the terrain) instead of importing it, or the bundler splits the shared modules into an extra chunk the first load has to fetch.

Starting and leaving a walk, for the map and the command menu:

| Call or callback                 | What it does                                                                                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `walkAt(x, z)`                   | Starts at the street nearest a spot on the ground (metres east and south of the middle, as `City` has them), within 30 m: the marker drops, the camera dives, the walker drops in. Works from the map, mid-flight, or on foot (then it cross-fades). |
| `walkAtScreen(clientX, clientY)` | The same for what's under a point on screen. A tap on the map calls it by itself; nothing in the app needs to.                                                                                                                                       |
| `walkFromCentre()`               | The same for the middle of the view: W, Enter and the menu's "Walk here".                                                                                                                                                                            |
| `stopWalking()`                  | Back to the map: the walker waves, the camera climbs to the nearest quarter view. "Back to the map" in the menu, Esc.                                                                                                                                |
| `onWalkModeChange(mode)`         | `'walk'` the moment a spawn starts (its flight plays after), `'map'` the moment leaving starts. The canvas carries it too, as `data-walk`, and `data-walker` holds where the walker stands once it has landed.                                       |
| `onWalkBlocked()`                | A spot with no street near: the scene shows a greyed marker there; the hint says so in words.                                                                                                                                                        |

The first call downloads walk mode, so the spawn starts a moment later the first time. Every call is safe at any time: during a flight, a new start turns the flight round from where the camera is.

`src/audio` exports one shared engine, `sound`. The app uses it for button taps and the sound toggle; walk mode imports `walking.ts` for footsteps and cues, so those ride in the walk chunk, and riding's chunk imports `riding.ts`.

## Portable by default

Code uses web-standard APIs and the [Portable](https://github.com/portablejs/portable) packages (`@portable/binary`, `@portable/compress`, `@portable/png`) instead of `node:*` or `bun:*` modules. That way the same code runs in the browser, in Bun scripts and in a Worker later.

- The only exceptions are `bun:test` in tests, the `Bun` global in `scripts/`, and `Glob` from `bun` in `src/modules.test.ts`.
- When you need something new (streams, timers, CSV, logging…), look in Portable before writing it or adding a package.

## Tests

`bun test` runs the `*.test.ts` files next to the code they test, inside `src/`. Every pure module is covered.

- Coverage below 95% lines or functions in any file fails the run, even when every test passes: look for the file in the coverage table.
- `src/modules.test.ts` imports every pure module, so a new file without tests still shows up in coverage instead of hiding.
- Browser-only code (`viewer.ts`, `walk.ts`, `ride.ts`, `plates.ts`, `facade-material.ts`, `character-material.ts`, `load.ts`, the React app; `BROWSER_ONLY` in `src/modules.test.ts`) is checked by the smoke test in `bun run verify` instead.
- When you add logic, put it in a pure function in `src/data` or a geometry builder in `src/scene` and test it there. Keep `viewer.ts` thin.

`src/data/baked.test.ts` decodes the committed `public/data/city.bin`, so a broken bake can't ship.

## TypeScript

The compiler is strict, with `noUncheckedIndexedAccess`.

- Use named exports only.
- Write `import type` for types; `bun run fix` fixes it.
- Comments explain why, not what.

Errors that can reach a user carry a message written for them. `CityLoadError` and `CityFormatError` are examples.

## Dependencies

Each runtime dependency has to earn its place:

| Package                                  | Why                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `three`                                  | The 3D engine. Plain three.js rather than a wrapper keeps the bundle and the abstraction small. |
| `react`, `react-dom`                     | The app shell and its menu                                                                      |
| `@portable/binary`, `@portable/compress` | The city file format                                                                            |

Dev tooling is Vite, oxlint, agent-browser (smoke test), `@portable/png` (icons) and type packages. Bun itself formats, type-checks and tests.

The data build (`tools/build_leuven_data.py`) is the one Python step: numpy, shapely, pyproj, tifffile, Pillow and matplotlib, pinned in the script's header and `tools/build_leuven_data.py.lock`, run by uv. The fetch planning it relies on (`src/data/sources.ts`, `src/data/fetch-plan.ts`) is TypeScript and tested like the rest.

Ask before adding a dependency, and prefer a few lines of our own code or a Portable package.
