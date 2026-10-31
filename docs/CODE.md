# Code

## Layers

The code is split by what it is allowed to know about. Lint enforces the arrows, so breaking one fails `bun run lint` with a message pointing here.

| Layer       | Holds                                                                          | May import                                                           |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `src/data`  | The city model, the binary format, geometry and projection maths, the map area | `@portable/*` and web APIs only. No three.js, React or other layers. |
| `src/scene` | Everything 3D: meshes, materials, camera, controls, the render loop            | `src/data`, three.js. No React.                                      |
| `src/app`   | The React shell: HUD, loading and error states, keyboard shortcuts             | `src/data`, `src/scene`                                              |
| `scripts/`  | Build-time edges: baking data, icons, budgets, the smoke test, deploys         | `src/data`, plus the `Bun` global for files and processes            |

`src/scene` exposes one entry point, `createViewer()`. It returns a small imperative handle (`rotate`, `resetView`, `setPixelated`, `stats`, `dispose`), so React never touches three.js objects.

## Portable by default

Code uses web-standard APIs and the [Portable](https://github.com/portablejs/portable) packages (`@portable/binary`, `@portable/compress`, `@portable/png`) instead of `node:*` or `bun:*` modules. That way the same code runs in the browser, in Bun scripts and in a Worker later.

- The only exceptions are `bun:test` in tests, the `Bun` global in `scripts/`, and `Glob` from `bun` in `src/modules.test.ts`.
- When you need something new (streams, timers, CSV, logging…), look in Portable before writing it or adding a package.

## Tests

`bun test` runs the `*.test.ts` files next to the code they test, inside `src/`. Every pure module is covered.

- Coverage below 95% lines or functions in any file fails the run, even when every test passes: look for the file in the coverage table.
- `src/modules.test.ts` imports every pure module, so a new file without tests still shows up in coverage instead of hiding.
- Browser-only code (`viewer.ts`, `trees.ts`, `facade-material.ts`, `load.ts`, the React app) is checked by the smoke test in `bun run verify` instead.
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
| `react`, `react-dom`                     | The HUD                                                                                         |
| `@portable/binary`, `@portable/compress` | The city file format                                                                            |

Dev tooling is Vite, oxlint, agent-browser (smoke test), `@portable/png` (icons) and type packages. Bun itself formats, type-checks and tests.

Ask before adding a dependency, and prefer a few lines of our own code or a Portable package.
