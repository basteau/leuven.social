# Code

## Layers

The code is split by what it is allowed to know about. Lint enforces the arrows, so breaking one fails `bun run lint` with a message pointing here.

| Layer       | Holds                                                                               | May import                                                           |
| ----------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/data`  | The city model, the binary format, geometry and projection maths, the map area      | `@portable/*` and web APIs only. No three.js, React or other layers. |
| `src/net`   | Multiplayer in the browser: the wire format, accounts, presence, smoothing          | `src/data`, `@portable/*` and web APIs. No three.js or React.        |
| `src/scene` | Everything 3D: meshes, materials, camera, controls, the render loop                 | `src/data`, `src/net`, `src/audio`, three.js. No React.              |
| `src/audio` | The few UI, walking and riding sounds, synthesised with Web Audio                   | Web APIs only. No three.js, React or other layers.                   |
| `src/app`   | The React shell: the command menu, the few things on the map, loading, shortcuts    | `src/data`, `src/net`, `src/scene`, `src/audio`                      |
| `scripts/`  | Build-time edges: fetching and baking data, icons, budgets, the smoke test, deploys | `src/data`, plus the `Bun` global for files and processes            |

`src/scene` exposes one entry point, `createViewer()`. It returns a small imperative handle, so React never touches three.js objects:

| Call                                             | What it does                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `rotate(direction)`, `spin(direction)`           | Turns the map a quarter, or keeps turning while a control is held, settling on the next quarter.                                    |
| `zoomBy(factor)`, `resetView()`                  | Zooms within 0.5 (the whole city) and 40 (a street; 8 to 20 inside a room); north at the top and the camera back on the avatar (R). |
| `steer(right, up)`, `run(on)`                    | Walks the avatar toward a direction on screen while held (W A S D), running or sprinting with Shift.                                |
| `recentre()`                                     | Pins the camera to the avatar again (Space, Esc, the arrow at the edge).                                                            |
| `lookAt(x, z)`                                   | Takes the camera to a spot (metres east and south of the middle, as `City` has them), down to zoom 8; the avatar stays put.         |
| `ride(action)`                                   | Gets on or off the nearest bike (`'toggle'`), walking to it if need be, or rings its bell (`'bell'`).                               |
| `door()`                                         | Goes into the building beside the avatar, or out of the one it is in (Enter): the one thing that moves it at once.                  |
| `rooms()`                                        | The rooms inside the landmarks for the menu, each `{ id, name, x, z }` at its door (loading their data if need be).                 |
| `timeOfDay()`, `nextTimeOfDay()`, `passTime(on)` | The light, and the day passing.                                                                                                     |
| `traffic(on)`, `trafficOn()`                     | Cars, buses, bikes and people on the streets.                                                                                       |
| `stats()`, `ready`, `dispose()`                  | The last frame's cost; a promise that settles once the first frame is drawn.                                                        |

There are no modes: one orthographic camera (`lod.ts`) zooms from the whole city down to a street, and one avatar (`avatar.ts`, its state; `avatar-layer.ts`, the glue) is on Grote Markt from the start. Everything worth drawing is a threshold on the view's height (`detailAt` in `lod.ts`). A tap on the map (the viewer's one tap test, beside the map controls' pan, pinch and wheel) sends the avatar there, walked or ridden along a route when the spot is within 250 m and refused otherwise. The camera is pinned to the avatar (`MapControls.pinned`) until a drag lets go. The viewer reports back through callbacks: `onStreetChange` with the street under the avatar for the street plate, `onPlaceChange` with the room and floor it is in, `onDoor` when a building it can go into is beside it or it is inside one, `onRideChange` when a bike is near or ridden, `onAvatarAt` with where the avatar is on screen and whether its figure is drawn, for the app's arrow (`src/app/pointer.ts`), `onBlocked` with why a tap went nowhere (`'far'` or `'closed'`), `onAvatarUnavailable` and `onRoomsUnavailable` when a download fails, `onHeading`, which way the view looks, and `onDaylight` with the light at the hour, from which the app paints the sky behind the canvas. The canvas carries `data-walker` (where the avatar stands), `data-place` and `data-floor`, `data-door` (the room beside or around it), `data-ride`, `data-avatar` and `data-zoom` for the smoke test.

What loads when:

| Chunk or file                                                                                                                                             | When                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The engine (`viewer.ts`, three.js, the palette)                                                                                                           | With the city, for the first frame                                                |
| The avatar (`avatar-layer.ts`) and its rooms' code (`interiors.ts`, `room-mesh.ts`, `src/data/rooms.ts`, `room-grid.ts`), the street names (`streets.ts`) | Once the first frame is drawn                                                     |
| The furniture, the traffic                                                                                                                                | Once the first frame is drawn                                                     |
| The plates (`plates.ts`) and `walk.bin`                                                                                                                   | When the view first comes down to the street (under 60 m tall)                    |
| The bikes (`bikes.ts`)                                                                                                                                    | When the avatar comes within 25 m of a parked bike, or on F                       |
| `rooms.json`                                                                                                                                              | When the avatar's figure is in view within 160 m of a landmark, or the menu opens |

A lazy chunk takes what it shares with the engine as a `kit` (three.js classes, `MeshBuilder`, the terrain) instead of importing it, or the bundler splits the shared modules into an extra chunk: the furniture and the traffic do, and the bikes take their three.js classes from the avatar. A chunk loaded from a chunk splits three.js off the engine even when it only imports it, so the rooms' code rides in the avatar's chunk; only their data waits.

`src/audio` exports one shared engine, `sound`. The app uses it for button taps and the sound toggle; the avatar imports `walking.ts` for footsteps and cues, and the bikes' chunk `riding.ts`.

## Portable by default

Code uses web-standard APIs and the [Portable](https://github.com/portablejs/portable) packages (`@portable/binary`, `@portable/compress`, `@portable/png`) instead of `node:*` or `bun:*` modules. That way the same code runs in the browser, in Bun scripts and in a Worker later.

- The only exceptions are `bun:test` in tests, the `Bun` global in `scripts/`, and `Glob` from `bun` in `src/modules.test.ts`.
- When you need something new (streams, timers, CSV, logging…), look in Portable before writing it or adding a package.

## Tests

`bun test` runs the `*.test.ts` files next to the code they test, inside `src/`. Every pure module is covered.

- Coverage below 95% lines or functions in any file fails the run, even when every test passes: look for the file in the coverage table.
- `src/modules.test.ts` imports every pure module, so a new file without tests still shows up in coverage instead of hiding.
- Browser-only code (`viewer.ts`, `avatar-layer.ts`, `bikes.ts`, `plates.ts`, `facade-material.ts`, `character-material.ts`, `load.ts`, the React app; `BROWSER_ONLY` in `src/modules.test.ts`) is checked by the smoke test in `bun run verify` instead.
- When you add logic, put it in a pure function in `src/data` or a geometry builder in `src/scene` and test it there. Keep `viewer.ts` thin.

`src/data/baked.test.ts` decodes the committed `public/data/city.bin`, so a broken bake can't ship, and checks `public/data/rooms.json` against it, so a room that no longer fits its building can't either.

## TypeScript

The compiler is strict, with `noUncheckedIndexedAccess`.

- Use named exports only.
- Write `import type` for types; `bun run fix` fixes it.
- Comments explain why, not what.

Errors that can reach a user carry a message written for them. `CityLoadError` and `CityFormatError` are examples.

## Dependencies

Each runtime dependency has to earn its place:

| Package                                  | Why                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `three`                                  | The 3D engine. Plain three.js rather than a wrapper keeps the bundle and the abstraction small.                                                                          |
| `react`, `react-dom`                     | The app shell and its menu                                                                                                                                               |
| `@portable/binary`, `@portable/compress` | The city file format, and the multiplayer wire format (`src/net/protocol.ts`)                                                                                            |
| `@portable/websockets`                   | The browser's presence socket: reconnects with backoff, runs code on every (re)connect before queued writes, and treats a deliberate close as final. About 3 kB.         |
| `better-auth`                            | Accounts on the server only: password hashing, sessions in a cookie, rate limits on sign-in, its tables migrated into our SQLite file. Security code we shouldn't write. |
| `@portable/rate-limit`                   | Server only: how many presence messages a connection may send, and sign-ups per address                                                                                  |
| `@portable/log`                          | Server only: namespaced logging, turned up with `DEBUG`                                                                                                                  |

Dev tooling is Vite, oxlint, agent-browser (smoke test), `@portable/png` (icons) and type packages. Bun itself formats, type-checks and tests.

The data build (`tools/build_leuven_data.py`) is the one Python step: numpy, shapely, pyproj, tifffile, Pillow and matplotlib, pinned in the script's header and `tools/build_leuven_data.py.lock`, run by uv. The fetch planning it relies on (`src/data/sources.ts`, `src/data/fetch-plan.ts`) is TypeScript and tested like the rest.

Ask before adding a dependency, and prefer a few lines of our own code or a Portable package.
