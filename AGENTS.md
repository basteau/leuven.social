# leuven.social

A tiny isometric, pixel-art 3D Leuven in the browser, built from open geodata: a React HUD over a plain three.js scene.

This project uses Bun for everything: installs, scripts, tests, type checking and formatting. Don't use npm, npx or tsc.

## Feedback loops

- `bun run verify:quick` runs formatting, lint, types and tests in parallel in well under a second. The pre-commit hook runs it too.
- `bun run verify` adds the production build, the size budgets and a smoke test in a real headless browser. Run it before calling work done, then look at the screenshots in `.artifacts/`.
- `bun run fix` formats and applies lint autofixes. A lint error message names the doc that explains its rule.
- If `bun test` exits 1 with 0 failures, a file in the coverage table is under the 95% floor.

A failing check is information, not an obstacle: fix the cause. Don't loosen a rule or raise a budget to get green unless the change really needs it, and say why when you do.

## Commits

Commit in small, well-scoped steps: one logical change per commit, with its tests and docs. Messages follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`, for example `fix(app): keep focus on retry`. Types are `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`. Scopes are usually the layer (`data`, `scene`, `app`, `pwa`, `scripts`) or `deps`. A hook rejects other formats, and the pre-commit hook runs `bun run verify:quick`.

## Where things are explained

- How the code is split into layers, what may import what, testing and dependencies: [docs/CODE.md](docs/CODE.md)
- Rendering and performance rules and budgets: [docs/RENDERING.md](docs/RENDERING.md)
- Where the city data comes from and how to grow the map: [docs/DATA.md](docs/DATA.md)
- How it should look and feel: [DESIGN.md](DESIGN.md)
- Background research, sources and ideas: [REPORT.md](REPORT.md)
- Publishing to https://leuven.exe.xyz/ with `bun run deploy`: [docs/DEPLOY.md](docs/DEPLOY.md)

## UI work

Load the `better-interface`, `good-css` and `mobile-native` skills before changing the HUD. Check the result in a browser with `bunx agent-browser` (the pinned version; start with `bunx agent-browser skills get core`), at phone and desktop sizes, rather than from the code alone.
