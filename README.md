# leuven.social

Leuven's historic centre as a tiny isometric 3D city in the browser. It is built from open Flemish geodata and OpenStreetMap, inspired by [Slop New York](https://github.com/mrdoob/slop-newyork).

**Live: [leuven.exe.xyz](https://leuven.exe.xyz/)**

```bash
bun install
bun run dev        # http://localhost:5173
```

Controls:

| Action     | Mouse or touch  | Keyboard   |
| ---------- | --------------- | ---------- |
| Pan        | Drag            | Arrow keys |
| Zoom       | Scroll or pinch | `+` / `-`  |
| Rotate     |                 | `Q` / `E`  |
| Reset view |                 | `R`        |

## Working on it

| Command                | What it does                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run verify:quick` | Format check, lint, types and tests with coverage, in parallel, in under a second. Runs on every commit.                                |
| `bun run verify`       | The above, plus the production build, size budgets and a headless-browser smoke test (screenshots in `.artifacts/`). Runs in CI.        |
| `bun run format`       | Formats everything                                                                                                                      |
| `bun run data`         | Rebuilds `public/data/city.bin` and `walk.bin` from scratch: downloads the open data, builds and bakes it (needs uv). See docs/DATA.md. |
| `bun run data:check`   | Rebuilds from the downloads in `data/` and checks the result is byte for byte the committed `city.bin` and `walk.bin`.                  |
| `bun run deploy`       | Builds and publishes to https://leuven.exe.xyz/. See docs/DEPLOY.md.                                                                    |

Read [AGENTS.md](AGENTS.md) first; it links to everything else:

- [docs/CODE.md](docs/CODE.md)
- [docs/RENDERING.md](docs/RENDERING.md)
- [docs/DATA.md](docs/DATA.md)
- [DESIGN.md](DESIGN.md)
- [REPORT.md](REPORT.md): the research behind it

## Licence and credits

- Map data © OpenStreetMap contributors (ODbL).
- GRB and DHMV II: "Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen".
- Code: [MIT](LICENSE).
- City data (`public/data/city.bin`) contains OpenStreetMap data, so it is licensed under the [ODbL](https://opendatacommons.org/licenses/odbl/). It also carries the GRB and DHMV II terms above.
- Vendored agent skills keep their own licences (see [.agents/skills/README.md](.agents/skills/README.md)).
