# Performance plan: re-applying on top of multiplayer

Written 2026-11-08. This plan covers the performance, hosting and cleanup work done on the single-player build, and how to redo it on top of the local worktree that has multiplayer and the rendering changes. That worktree wasn't visible when this was written, so everything about it is an assumption to confirm. Re-measure before trusting any number below.

## Where the earlier work lives

Nothing from it is on `main`. It is on the local branch `archive/perf-hosting-2026-11-08` (not pushed; push it with `git push origin archive/perf-hosting-2026-11-08` or `git bundle` it to move it to the other PC). One live deploy of that branch, release `20261107T235825-694e6f9`, is still serving https://leuven.exe.xyz/. Redeploying from `main` replaces it.

| Commit    | What it does                                                                                                                                                                                                  | Re-apply how                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `285e64d` | `scripts/deploy.ts`: gzip -9 `.gz` beside text assets, nginx `gzip_static`, `gzip_vary`, `/data/` uncompressed, keep the last 7 days of old `assets/` so open tabs don't 404 on lazy chunks; `docs/DEPLOY.md` | Cherry-pick. Touches no game code. Safe first step.                                               |
| `5077f52` | `vite.config.ts`: `modulepreload` for the engine and palette chunks. `public/sw.js`: a cached page opens after 4 s of network silence                                                                         | Cherry-pick, then check the chunk names still match and the HTML stays under its budget.          |
| `541d25a` | `src/scene/resolution.ts` (+ tests): dynamic resolution scaler, wired into `viewer.ts`                                                                                                                        | Re-implement the wiring by hand; take the pure module as is.                                      |
| `694e6f9` | Fix to the wiring above: feed the scaler only from walk-loop frames, reset it on the map                                                                                                                      | Fold into the re-implemented wiring. Do not apply the first wiring without it.                    |
| `ff1384b` | Five copies of the angle `wrap` merged into one in `motion.ts`                                                                                                                                                | Optional. Skip it while the rendering code is changing; it only touches files likely to conflict. |
| `870c225` | Drops `ringInside` from `geometry.ts`, which only its own test used                                                                                                                                           | Optional, trivial. Re-check it is still unused first.                                             |

Prefer `git cherry-pick -n <sha>` and resolve by hand over a merge, since the rendering code underneath has moved.

## What was learned (keep these, they cost hours)

Measuring:

- **Never pass `--disable-frame-rate-limit`.** With it, requestAnimationFrame is uncapped and the walk loop floods the GPU queue: 2.4 s stalls every few seconds that look like a shader problem and are not.
- **A fixed scale hides nothing; a moving one costs.** Resizing the drawing buffer reallocates it. The first scaler version fed on-demand map frames to the scaler, read user-input gaps as slow frames, and kept resizing, which itself produced 33 ms frames in walk mode. After the fix the scaler never fired on the test GPU and walk mode held 60 fps (desktop 1440x900 and phone 390x844 at 3x, also at 4x CPU throttle). If walk mode drops frames, log `scaler.scale` and the canvas width per frame before blaming the GPU.
- **Software GL is not representative.** SwiftShader runs GL on the main thread and lacks `KHR_parallel_shader_compile`, which makes `bun run smoke` fail on that one console warning. Use hardware GL (`--use-gl=angle --use-angle=gl`) for numbers and for smoke. Don't loosen `smoke.ts` for the warning.
- `vite preview` caches its file list at start: restart it after every rebuild or you measure the old build.
- The harness used was a small CDP script (frame times from a requestAnimationFrame loop, `Performance.getMetrics` for script time, CPU throttle via `Emulation.setCPUThrottlingRate`, draw calls and triangles from the canvas `data-*` attributes). It lived in a scratchpad and was not committed; consider committing a version as `scripts/perf.ts`.
- Environment: this repo wants bun 1.4.4 (`bun fmt` and `bun check` don't exist in 1.4.2). After `bun upgrade`, `bunx` was missing: use `bun x`. Headless Chrome on Ubuntu needs `--no-sandbox`. `pkill -f` with a pattern that appears in its own command line kills your shell: write `[c]hrome`.

Findings about the single-player build, all measured on one AMD iGPU:

- Map view: locked 60 fps, 25 draw calls, about 215k triangles, near-zero idle CPU because it renders on demand.
- First load is about 1.1 MB on the wire (city.bin 767 KB, the rest about 290 KB). nginx on the VM served 1000 concurrent full first loads in about a second on loopback; the limit is the uplink, not CPU. A CDN is only worth it if the uplink limits you.
- The size budgets in `scripts/budget.ts` were within 1% of their caps (first-load JS 251.0 of 251 KB). Anything that adds first-load code must remove some.
- No code is cheaply removable: a sweep found one unused function and no unreferenced files, assets or dependencies.

## Plan on top of the multiplayer worktree

Do these in order. Each step ends with `bun run verify`, a before/after table, and a commit on its own.

### 0. Re-baseline (before touching anything)

On the other PC's worktree, with hardware GL and a quiet machine, record for map and walk, at 1440x900 and 390x844 at 3x, unthrottled and at 4x CPU: fps, p95 and max frame time, frames over 20 ms, draw calls, triangles, JS heap, longest task. Do it with 0, 50 and 1000 simulated remote players (see step 3). Everything after compares to this table. If the rendering changes already moved the budgets, update the table in `docs/RENDERING.md` first, as a separate commit.

### 1. Hosting changes (`285e64d`, `5077f52`)

Cherry-pick, build, run `bun run budget`, then `nginx -t` runs inside deploy. If multiplayer adds a realtime endpoint, decide where it lives before deploying: WebSocket upgrade needs `proxy_pass` with `Upgrade` and `Connection` headers, and exe.dev's proxy must allow it. Do not serve it from the static nginx site without a separate `location`.

### 2. Resolution scaler (`541d25a`, `694e6f9`)

Add `resolution.ts` and its tests unchanged. In `viewer.ts`, take the pixel ratio from `pixelRatio(devicePixelRatio, scaler.scale)`, feed `scaler.frame(performance.now())` only from frames drawn by a continuous loop (walk, riding, flights), reset on the map and on a screen-density change. Re-check what "continuous" means after multiplayer: if remote players make the map redraw every frame, map frames become continuous too and the rule must change (feed the scaler from any frame in a loop that requested the next one from inside itself). Acceptance: on the test GPU the scaler stays at 1 with no stalls; on a throttled run it steps down at most once per half second and recovers without flapping.

### 3. Multiplayer at 1000 players: what has to be true

These are targets to design against, not things already built. Confirm which already hold in the multiplayer code.

- **One draw call per kind of thing, not per player.** 1000 full character rigs (the character is about 1000 lines of meshes) cannot be drawn. Draw the nearest 20 to 40 as full rigs, the rest as an instanced low-detail mesh or billboards (one draw call for all), and skip those out of view using the existing 350 m cell grid. Cap the number of rendered remote players and fade the extras out; show a count.
- **Interest management.** A client receives only the players in nearby cells, not all 1000. Reuse the 350 m cells as the unit. Typical load: 50 visible neighbours x 12 bytes x 10 Hz is about 6 KB/s per client, about 6 MB/s total from the server for 1000 clients.
- **Send little, often enough.** Binary messages (the project already uses `@portable/binary`), 10 to 20 Hz position and heading in quantised form (centimetres), deltas, no JSON per tick. Clients interpolate between snapshots about 100 ms behind to hide jitter and never extrapolate far.
- **No per-frame allocation for remote players.** Preallocated typed arrays for positions and instance matrices; update the instance buffer only for players whose snapshot changed.
- **Keep the render loop from becoming continuous in map view.** Today the map renders only when something changes, which is why idle CPU is near zero. Remote players moving will force redraws: update them at the snapshot rate (10 to 20 Hz) with interpolation only while at least one is visible, and stay idle when none is.
- **Server.** One process handles 1000 sockets easily; the cost is fan-out. Shard by cell group if one process saturates. Decide WebSocket (simplest, works everywhere) versus WebTransport (lower latency, not on every browser). Measure server CPU and outbound bandwidth with a synthetic client swarm before real users.
- **Fail soft.** If the connection drops or the server is slow, the single-player game must keep running at 60 fps; players freeze and fade, nothing blocks the render loop.

Test it with a synthetic swarm: a script that connects 1000 bots walking random streets, plus a real browser measuring the table from step 0.

### 4. Code and docs

After steps 1 to 3 are green, re-run a dead-code sweep on the merged tree. Only remove what is unreferenced there. Update `docs/RENDERING.md` (scaler, hosting, remote-player budget), `docs/CODE.md` (the new layer for networking and what it may import) and the budgets in `scripts/budget.ts` with a reason for each change.

## Acceptance for "done"

- `bun run verify` green on hardware GL, including the smoke test.
- Walk and map hold 60 fps (p95 16.8 ms, no frames over 34 ms) on desktop and phone viewport, unthrottled, with 0 and with 50 remote players in view; with 1000 connected the client still holds it because only nearby players are drawn.
- At 4x CPU throttle: no stalls over 100 ms and a recovering, non-flapping scaler.
- Real phone check (a mid-range Android and an iPhone) before announcing: nothing here proves real-device fps.
- Deploy only after the above, and check the live headers (`curl -I` for `/`, a hashed asset and `data/city.bin`).
