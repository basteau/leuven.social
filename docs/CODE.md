# Code

## Layers

The code is split by what it is allowed to know about. Lint enforces the arrows, so breaking one fails `bun run lint` with a message pointing here.

| Layer       | Holds                                                                                           | May import                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/data`  | The city model, the binary format, geometry and projection maths, the map area                  | `@portable/*` and web APIs only. No three.js, React or other layers. |
| `src/net`   | Multiplayer in the browser: the wire format, accounts, presence, smoothing                      | `src/data`, `@portable/*` and web APIs. No three.js or React.        |
| `src/scene` | Everything 3D: meshes, materials, camera, controls, the render loop                             | `src/data`, `src/net`, `src/audio`, three.js. No React.              |
| `src/audio` | The few UI, walking and riding sounds, synthesised with Web Audio                               | Web APIs only. No three.js, React or other layers.                   |
| `src/app`   | The React shell: the command menu, the few things on the map, loading, shortcuts                | `src/data`, `src/net`, `src/scene`, `src/audio`                      |
| `scripts/`  | Build-time edges: fetching and baking data, icons, budgets, the smoke test, deploys, load tests | `src/data`, `src/net`, plus the `Bun` global for files and processes |
| `server/`   | The multiplayer server: accounts, the presence hub, SQLite ([MULTIPLAYER.md])                   | `src/net`, `src/data`, the `Bun` global, `bun:sqlite`, `process.env` |

[MULTIPLAYER.md]: MULTIPLAYER.md

`src/scene` exposes one entry point, `createViewer()`. It returns a small imperative handle, so React never touches three.js objects:

| Call                                             | What it does                                                                                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rotate(direction)`, `spin(direction)`           | Turns the map a quarter, or keeps turning while a control is held, settling on the next quarter.                                                                                             |
| `zoomBy(factor)`, `resetView()`                  | Zooms within the window's limit (`zoom-limit.ts`: 0.5 at 1280×800, further out on a phone) and 40 (a street; 8 to 20 inside a room); north at the top and the camera back on the avatar (R). |
| `steer(right, up)`, `run(on)`                    | Walks the avatar toward a direction on screen while held (W A S D), running or sprinting with Shift.                                                                                         |
| `recentre()`                                     | Pins the camera to the avatar again (Space, Esc once no route is being walked, the arrow at the edge).                                                                                       |
| `navigateTo(x, z)`                               | Walks or rides to the street nearest a spot and pins the camera (a mark's Navigate on the full map). Past a tap's 250 m, as far as the router's window reaches (about 360 m).                |
| `cancelRoute()`                                  | Lets go of the route to a picked spot (Stop, Esc, the menu).                                                                                                                                 |
| `presences()`, `routeTarget()`                   | You and the other players, and the end of the picked route, for the full map.                                                                                                                |
| `cover(on)`                                      | The full map is over the canvas: everything moves on, undrawn, until it shuts.                                                                                                               |
| `lookAt(x, z)`                                   | Takes the camera to a spot (metres east and south of the middle, as `City` has them), down to zoom 8; the avatar stays put.                                                                  |
| `ride(action)`                                   | Gets on or off the nearest bike (`'toggle'`), walking to it if need be, or rings its bell (`'bell'`).                                                                                        |
| `door()`                                         | Goes into the building beside the avatar, or out of the one it is in (Enter): the one thing that moves it at once.                                                                           |
| `rooms()`                                        | The rooms inside the landmarks for the menu, each `{ id, name, x, z }` at its door (loading their data if need be).                                                                          |
| `timeOfDay()`, `nextTimeOfDay()`, `passTime(on)` | The light, and the day passing.                                                                                                                                                              |
| `others(roster)`                                 | The other players to draw: a `Roster` the app keeps from the network (who, how they look, where at a moment, told where the map looks), or null.                                             |
| `dress(outfit)`, `placeAvatar(x, z, heading)`    | Your clothes, skin and hair; back where you left last time (on foot, in the street).                                                                                                         |
| `stats()`, `ready`, `dispose()`                  | The last frame's cost; a promise that settles once the first frame is drawn.                                                                                                                 |

There are no modes: one orthographic camera (`lod.ts`) zooms from the whole city down to a street, and one avatar (`avatar.ts`, its state; `avatar-layer.ts`, the glue) is on Grote Markt from the start. Everything worth drawing is a threshold on the view's height (`detailAt` in `lod.ts`). A tap on the map (the viewer's one tap test, beside the map controls' pan, pinch and wheel) sends the avatar there, walked or ridden along a route when the spot is within 250 m and refused otherwise. The camera is pinned to the avatar (`MapControls.pinned`) until a drag lets go. The viewer reports back through callbacks: `onStreetChange` with the street under the avatar for the street plate, `onPlaceChange` with the room and floor it is in, `onDoor` when a building it can go into is beside it or it is inside one, `onRideChange` when a bike is near or ridden, `onAvatarAt` with where the avatar is on screen and whether its figure is drawn, for the app's arrow (`src/app/pointer.ts`), `onBlocked` with why a tap went nowhere (`'far'` or `'closed'`), `onAvatarUnavailable` and `onRoomsUnavailable` when a download fails, `onHeading`, which way the view looks, and `onDaylight` with the light at the hour, from which the app paints the sky behind the canvas. `onMove` says where the avatar is and what it's doing whenever that changes, for the other players and the minimap; the other players' name tags go in the `tags` element the app lays over the canvas. The canvas carries `data-walker` (where the avatar stands), `data-place` and `data-floor`, `data-door` (the room beside or around it), `data-ride`, `data-avatar` and `data-zoom` for the smoke test.

What loads when:

| Chunk or file                                                                                                                                             | When                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The engine (`viewer.ts`, three.js, the palette)                                                                                                           | With the city, for the first frame                                                |
| The avatar (`avatar-layer.ts`) and its rooms' code (`interiors.ts`, `room-mesh.ts`, `src/data/rooms.ts`, `room-grid.ts`), the street names (`streets.ts`) | Once the first frame is drawn                                                     |
| The furniture                                                                                                                                             | Once the first frame is drawn                                                     |
| The minimap (`minimap-view.tsx`), the other players (`multiplayer.ts`, `src/net/`)                                                                        | Once the first frame is drawn                                                     |
| The full map (`map-overlay.tsx`, `map-raster.ts`, `map-draw.ts` and `map.css`)                                                                            | When it is first opened (M, the map button or the menu)                           |
| The account sheet (`account-sheet.tsx` and its CSS)                                                                                                       | When it is first opened (the corner, L or the menu)                               |
| The rider and the bike's rig (`rider.ts`)                                                                                                                 | With the bikes, or when another player near rides                                 |
| The bikes (`bikes.ts`)                                                                                                                                    | When the avatar comes within 25 m of a parked bike, or on F                       |
| `rooms.json`                                                                                                                                              | When the avatar's figure is in view within 160 m of a landmark, or the menu opens |

A lazy chunk takes what it shares with the engine as a `kit` (three.js classes, `MeshBuilder`, the terrain) instead of importing it, or the bundler splits the shared modules into an extra chunk: the furniture does, and the bikes take their three.js classes from the avatar. A chunk loaded from a chunk splits three.js off the engine even when it only imports it, so the rooms' code rides in the avatar's chunk; only their data waits.

### The full map

Everyone on the map is a `Presence` (`src/data/presence.ts`): `{ id, x, z, heading, self }`. `viewer.presences()` returns the list, you and then the other players, and the full map (`src/app/map-overlay.tsx`) draws every entry from it. The minimap keeps reading `live`, which is written as things move. The map's maths is pure and tested in `src/data`: `map-view.ts` (projection, footprint simplifying) and `waypoints.ts` (marks kept in `localStorage`, parsed defensively).

A route to a picked spot (a tap on the street, or a mark's Navigate here) is what `onRoute` reports: the Stop pill, Escape and the menu's Stop navigating use it. A bike's own short route to its rack doesn't count.

`src/audio` exports one shared engine, `sound`. The app uses it for button taps and the sound toggle; the avatar imports `walking.ts` for footsteps and cues, and the bikes' chunk `riding.ts`.

## Portable by default

Code uses web-standard APIs and the [Portable](https://github.com/portablejs/portable) packages (`@portable/binary`, `@portable/compress`, `@portable/png`) instead of `node:*` or `bun:*` modules. That way the same code runs in the browser, in Bun scripts and in a Worker later.

- The only exceptions are `bun:test` in tests, the `Bun` global in `scripts/` and `server/`, `bun:sqlite` and `process.env` in `server/`, and `Glob` from `bun` in `src/modules.test.ts`. `src/net` is shared by the browser and the server, so it stays portable too.
- When you need something new (streams, timers, CSV, logging…), look in Portable before writing it or adding a package.

## Tests

`bun test` runs the `*.test.ts` files next to the code they test, inside `src/` and `server/`. Every pure module is covered.

- Coverage below 95% lines or functions in any file fails the run, even when every test passes: look for the file in the coverage table.
- `src/modules.test.ts` imports every pure module, so a new file without tests still shows up in coverage instead of hiding.
- The server's tests drive the presence hub (`server/world.ts`) with fake connections, and start the real server on port 0 with SQLite in memory (`server/server.test.ts`): accounts, cookies and WebSockets end to end, `src/net/account.ts` included. `server/main.ts` only reads the environment and isn't measured.
- Browser-only code (`viewer.ts`, `avatar-layer.ts`, `bikes.ts`, `facade-material.ts`, `character-material.ts`, `load.ts`, the React app; `BROWSER_ONLY` in `src/modules.test.ts`) is checked by the smoke test in `bun run verify` instead.
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
