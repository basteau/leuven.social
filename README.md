# leuven.social

Leuven's historic centre as a tiny isometric pixel-art city in the browser. It is built from open Flemish geodata and OpenStreetMap, inspired by [Slop New York](https://github.com/mrdoob/slop-newyork).

```bash
bun install
bun run dev        # http://localhost:5173
```

Controls:

| Action               | Mouse or touch  | Keyboard   |
| -------------------- | --------------- | ---------- |
| Pan                  | Drag            | Arrow keys |
| Zoom                 | Scroll or pinch | `+` / `-`  |
| Rotate               |                 | `Q` / `E`  |
| Pixel look on or off |                 | `P`        |
| Reset view           |                 | `R`        |

## Working on it

| Command                | What it does                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `bun run verify:quick` | Format check, lint, types and tests with coverage, in parallel, in under a second. Runs on every commit.                         |
| `bun run verify`       | The above, plus the production build, size budgets and a headless-browser smoke test (screenshots in `.artifacts/`). Runs in CI. |
| `bun run format`       | Formats everything                                                                                                               |
| `bun run bake`         | Rebuilds `public/data/city.bin` from the raw data. See docs/DATA.md.                                                             |

Read [AGENTS.md](AGENTS.md) first; it links to everything else:

- [docs/CODE.md](docs/CODE.md)
- [docs/RENDERING.md](docs/RENDERING.md)
- [docs/DATA.md](docs/DATA.md)
- [DESIGN.md](DESIGN.md)
- [REPORT.md](REPORT.md): the research behind it

## Credits

- Map data © OpenStreetMap contributors (ODbL).
- GRB and DHMV II: "Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen".
