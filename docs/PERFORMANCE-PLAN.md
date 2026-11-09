# Performance plan: re-applying on top of multiplayer

> **Status, 2026-11-08: built directly on `main`, one thing still open.** The archive branch's commits weren't on this machine, so the hosting and scaler work below was written afresh from this plan. Steps 0 to 4 are in: `scripts/perf.ts` and `scripts/swarm.ts`, precompressed hosting, dynamic resolution, interest management, delta moves and the crowd. Results are in [RENDERING.md](RENDERING.md) ("Measuring") and [MULTIPLAYER.md](MULTIPLAYER.md) ("Load"). Step 3b was measured and none of it paid its way (a ring of pre-built cells was built and taken out again): the numbers are in RENDERING.md, and only splitting `city.bin` would help, on connections around 400 kbit/s. Step 3b's numbers predate the 1 km² zoom limit and the map's growth (RENDERING.md says what that leaves open). **Still open: no real phone has been tried**, so "Acceptance" below isn't fully met until someone opens it on a mid-range Android and an iPhone. What follows is the plan as it was written; its budgets and file names (`walk.ts` is gone) are as they were.

Written 2026-11-08. This plan covers the performance, hosting and cleanup work done on the single-player build, and how to redo it on top of the local worktree that has multiplayer and the rendering changes. That worktree wasn't visible when this was written, so everything about it is an assumption to confirm. Re-measure before trusting any number below.

## Runbook for the MacBook (read this first)

For whoever (a person or a Claude session) runs this on the MacBook, in `~/basteau/leuven.social`, where the multiplayer and rendering changes are uncommitted. Nothing here needs the other machine. Do the steps in order and stop at the first red `bun run verify`.

1. **Save the work first.** `git status`, then `git switch -c mac/multiplayer` and commit everything in a few logical commits (server, protocol, client networking, rendering). `git push origin mac/multiplayer` so it can't be lost. Never `git stash drop` or reset the worktree.
2. **Bring in `main`.** `git fetch origin && git switch -c integrate/visuals-and-perf mac/multiplayer && git merge origin/main`. `main` holds the single-player visual and map work (see "Visual and map work merged on top"). Expect conflicts in `viewer.ts`, `App.tsx`, `shortcuts.ts`, `commands.ts`, `app.css`, `scripts/budget.ts`, `scripts/smoke.ts`, `docs/*`; resolve them keeping both sides: the Mac's networking and rendering plus `main`'s `Presence` list, map, radar, Stop pill, zoom limit. Rendering conflicts (`palette.ts`, `buildings.ts`, `terraces.ts`, `storefronts.ts`, `rails.ts`, `lighting.ts`): the Mac's version wins unless it is plainly the older of the two; re-check colours in a screenshot afterwards. Run `bun install`, `bun run verify`, and look at `.artifacts/`.
3. **Wire multiplayer into the existing seams, not new ones.** Remote players become `Presence` entries with `self: false` (`src/data/presence.ts`, `viewer.presences()`): the radar and map already draw them, and only `self: true` gets the plumbob. Menu and shortcut changes go through `commands.ts` and `shortcuts.ts` (`M` is the map, `N` is mute). If the Mac already uses `M` or `N`, change one side and update the key sheet.
4. **Then the plan below**, steps 0 to 4, each its own commit with its own before/after table.
5. **Check budgets honestly.** Budgets on `main` were raised for the map (first-load JS 253 KB, engine 169 KB, furniture 9 KB, walk 21 KB). Multiplayer will add networking JS: put it in a lazy chunk loaded after the first frame (a solo visitor should still not pay for it, and the server may be down), and raise a budget only with a reason in the commit.
6. **Do not deploy** until step 1 of the plan ("Hosting changes") is done.

## Where the earlier work lives

Nothing from it is on `main`. It is on the local branch `archive/perf-hosting-2026-11-08` (not pushed; push it with `git push origin archive/perf-hosting-2026-11-08` or `git bundle` it to move it to the other PC). That branch was deployed once as release `20261107T235825-694e6f9`; it is no longer live (see the deploy warning in step 1) but is still on the VM. Do not redeploy it or `main` until the deploy script handles multiplayer.

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

Cherry-pick, build, run `bun run budget`, then `nginx -t` runs inside deploy. **Deploying is dangerous until `scripts/deploy.ts` knows about multiplayer.** On 2026-11-08 a `bun run deploy` from the single-player tree replaced the VM's nginx site with a static-only one and moved `/srv/leuven/current` to a static release, which cut `/ws` and `/api/` off from the running `leuven-server.service`. It was repaired by hand: the live site now runs release `20261107T160502-2ba5d2d` (layout `site/` plus `server/`) behind a rebuilt nginx config that proxies `/ws` (with the Upgrade headers and a 1 hour read timeout) and `/api/` to `127.0.0.1:8787`. That config is a reconstruction; the original is gone. Before any deploy, make the script (a) write that proxying, (b) use the `site/` and `server/` layout the service expects (`ExecStart` runs `/srv/leuven/current/server/main.js`), (c) restart the service when the server bundle changed, and (d) keep a backup of the previous nginx site file so a bad deploy can be undone. A copy of the config from the static deploy is on the VM at `/etc/nginx/sites-available/leuven.static-after-deploy.bak`.

### 2. Resolution scaler (`541d25a`, `694e6f9`)

Add `resolution.ts` and its tests unchanged. In `viewer.ts`, take the pixel ratio from `pixelRatio(devicePixelRatio, scaler.scale)`, feed `scaler.frame(performance.now())` only from frames drawn by a continuous loop (walk, riding, flights), reset on the map and on a screen-density change. Re-check what "continuous" means after multiplayer: if remote players make the map redraw every frame, map frames become continuous too and the rule must change (feed the scaler from any frame in a loop that requested the next one from inside itself). Acceptance: on the test GPU the scaler stays at 1 with no stalls; on a throttled run it steps down at most once per half second and recovers without flapping.

### 3. Multiplayer at 1000 players

**What the deployed server does today.** Read from the bundled `server/main.js` of release `20261107T160502-2ba5d2d` on the VM (the MacBook build; its source `server/world.ts` and `src/net/protocol.ts` was not available here, so re-check each point in the real source before acting):

- One Bun process, a WebSocket at `/ws` and a REST API at `/api/*` on `127.0.0.1:8787`, SQLite for accounts and last positions, sign-in by better-auth. One socket per account (a second login kicks the first).
- Binary protocol: the client sends its own state (x, z as float32, heading u16, speed u8, mode, floor, a `place` string); at most 20 messages per second per client, 1024-byte payload cap. The server clamps positions to the map area but does not limit how far a player moves between messages.
- Every 100 ms the server sends **all players that changed to all clients**, in one frame encoded once. An entry is about 16 bytes (more when `place` is set). That is an O(N²) fan-out: with 1000 players all moving, each client receives about 16 KB per tick, about 160 KB/s, and the server sends about 160 MB/s (roughly 1.3 Gbps). One VM uplink will not carry that, and each phone would receive that much too.
- A new connection receives one `join` frame per connected player, and every join is also broadcast to everyone: 1000 players arriving together cost about a million small frames.
- Saving positions runs inline in the tick (a SQLite write per client every 15 s), and slow clients are closed (`closeOnBackpressureLimit`) instead of skipped.

**Likely improvements, in priority order** (each needs measuring on the real code before and after):

1. **Interest management.** Send a client only the players in its own cell and the neighbouring cells, using the 350 m grid the renderer already uses. This turns O(N²) into O(N × neighbours) and is the one change that makes 1000 players possible. Bun's built-in pub/sub (`subscribe` per cell topic, `server.publish` per cell) fits it. Spatial grids for interest are the standard approach (see the SCORE and SpatialOS references below).
2. **Smaller entries.** Positions as 16-bit offsets in the map area (centimetre-level precision over a few kilometres), `place` as a small numeric id sent once on join, mode and floor packed in one byte: about 8 bytes an entry, half of today.
3. **Delta snapshots.** Send only what changed since a baseline the client acknowledged, with one bit for "unchanged" (Gaffer on Games, "Snapshot Compression"). Players standing still already cost nothing, because the server skips unchanged states; deltas matter for the many that move slowly.
4. **Distance-based update rate.** Full 10 Hz for the near cells, 2 to 5 Hz for far ones. Heading and speed are already in each entry, so clients can dead-reckon between snapshots.
5. **Batch the join burst.** One frame with the whole nearby roster, not one frame per player; send arrivals in the next tick's frame.
6. **Back-pressure that skips instead of closing.** State is latest-wins, so a slow client should miss updates, not be disconnected. Check the `send` return value and the socket's buffered amount. Do not enable per-message compression before measuring CPU: at 16 KB frames and 1000 sockets it may cost more than it saves.
7. **Batch saves** in one SQLite transaction off the tick, and add a `/api/health` that reports tick time, bytes out per second and client count, so load tests have numbers.
8. **Reject impossible moves.** Cap displacement per message by speed times elapsed time plus slack, so a client can't teleport.

**Client side, to check in the real code:** how often it sends (the server allows 20 per second; 5 to 10 is plenty), whether remote players are interpolated about 100 to 150 ms behind the newest snapshot, whether each remote player costs allocations or draw calls (see below), and what happens to rendering when the connection drops.

**Test it with a bot swarm, not guesses.** A script that logs in and connects 1000 bots walking random streets, run against a local server, reporting server tick time, bytes out per second and per-client bytes per second, while a real browser records the step 0 table. Compare the O(N²) baseline with each change above. The aim is under 20 KB/s per client and under 20 ms of tick time at 1000 bots.

References: [Bun WebSocket docs (pub/sub, backpressure)](https://bun.com/docs/api/websockets), [Gaffer on Games, Snapshot Compression](https://gafferongames.com/post/snapshot_compression/), [Improbable: dynamic interest management](https://medium.com/improbable-engineering/thinking-spatially-using-dynamic-interest-management-to-create-revolutionary-game-designs-80ed0fe7693). These are background only; no benchmark in them was reproduced here.

**What has to be true on the client for 1000 players.** These are targets to design against, not things already built. Confirm which already hold in the multiplayer code.

- **One draw call per kind of thing, not per player.** 1000 full character rigs (the character is about 1000 lines of meshes) cannot be drawn. Draw the nearest 20 to 40 as full rigs, the rest as an instanced low-detail mesh or billboards (one draw call for all), and skip those out of view using the existing 350 m cell grid. Cap the number of rendered remote players and fade the extras out; show a count.
- **Interest management.** A client receives only the players in nearby cells, not all 1000. Reuse the 350 m cells as the unit. Typical load: 50 visible neighbours x 12 bytes x 10 Hz is about 6 KB/s per client, about 6 MB/s total from the server for 1000 clients.
- **Send little, often enough.** Binary messages (the project already uses `@portable/binary`), 10 to 20 Hz position and heading in quantised form (centimetres), deltas, no JSON per tick. Clients interpolate between snapshots about 100 ms behind to hide jitter and never extrapolate far.
- **No per-frame allocation for remote players.** Preallocated typed arrays for positions and instance matrices; update the instance buffer only for players whose snapshot changed.
- **Keep the render loop from becoming continuous in map view.** Today the map renders only when something changes, which is why idle CPU is near zero. Remote players moving will force redraws: update them at the snapshot rate (10 to 20 Hz) with interpolation only while at least one is visible, and stay idle when none is.
- **Server.** One process handles 1000 sockets easily; the cost is fan-out. Shard by cell group if one process saturates. Decide WebSocket (simplest, works everywhere) versus WebTransport (lower latency, not on every browser). Measure server CPU and outbound bandwidth with a synthetic client swarm before real users.
- **Fail soft.** If the connection drops or the server is slow, the single-player game must keep running at 60 fps; players freeze and fade, nothing blocks the render loop.

Test it with a synthetic swarm: a script that connects 1000 bots walking random streets, plus a real browser measuring the table from step 0.

### 3b. Chunk-by-chunk loading (after 3, measure first)

The renderer already cuts the city into 350 m cells, builds and culls them one by one, and loads walk mode, furniture and plates as lazy chunks. What is still monolithic: `city.bin` (767 KB gzipped) is fetched and decoded whole before the first frame, every cell is built on the main thread, and a built cell is never evicted. Measure first (first-frame time on a throttled network and CPU; main-thread time per cell build; GPU memory after panning across the city). Only then, in this order, keeping what pays off: (1) pre-build only the cells in the zoom-limited view and a prefetch ring, the rest on demand as the view pans (the zoom limit in `zoom-limit.ts` bounds the ring); (2) evict cells far from the view past a memory cap (rebuild on return; `MeshBuilder` already frees CPU arrays after upload); (3) build cells in a worker and transfer the buffers; (4) split `city.bin` into per-region files if (1) to (3) leave download or decode as the bottleneck. Key everything on the same cell index the server's interest management uses (step 3 of this plan), so the client asks the server for the same cells it has loaded and drops the ones it evicted.

### 4. Code and docs

After steps 1 to 3 are green, re-run a dead-code sweep on the merged tree. Only remove what is unreferenced there. Update `docs/RENDERING.md` (scaler, hosting, remote-player budget), `docs/CODE.md` (the new layer for networking and what it may import) and the budgets in `scripts/budget.ts` with a reason for each change.

## Acceptance for "done"

- `bun run verify` green on hardware GL, including the smoke test.
- Walk and map hold 60 fps (p95 16.8 ms, no frames over 34 ms) on desktop and phone viewport, unthrottled, with 0 and with 50 remote players in view; with 1000 connected the client still holds it because only nearby players are drawn.
- At 4x CPU throttle: no stalls over 100 ms and a recovering, non-flapping scaler.
- Real phone check (a mid-range Android and an iPhone) before announcing: nothing here proves real-device fps.
- Deploy only after the above, and check the live headers (`curl -I` for `/`, a hashed asset and `data/city.bin`).

## Visual and map work merged on top (2026-11-08)

Merged after the plan above was written, so the MacBook port has to carry them too:

- **Scene look:** block-coherent wall palettes and warmer flat roofs (`palette.ts`, `buildings.ts`), catenary wires and braced masts (`rails.ts`), sun/shade constants (`lighting.ts`), café colour families, terrace layouts, menu boards and rimmed shop signs (`terraces.ts`, `storefronts.ts`), calmer bike and rack colours.
- **Zoom limit by ground area** (`src/scene/zoom-limit.ts`, recomputed on resize): bounds the triangles in any frame. Furniture is only built for cells within 700 m of the view's middle.
- **Map, radar, marks, Stop pill, plumbob.** `viewer.presences()` returns `Presence` entries with a `self` flag: multiplayer adds remote players as `self: false` entries and nothing else needs to change. `M` now opens the map and mute moved to `N`.
- **Merge hotspots with the MacBook code:** `viewer.ts`, `App.tsx`, `shortcuts.ts`, `commands.ts`, `scripts/budget.ts` and `scripts/smoke.ts` (budgets were raised: first-load JS 253 KB, engine 169 KB). Port by cherry-picking commit by commit and re-running `bun run verify`.
- **Next architecture step:** chunk-per-chunk loading (per-region data files, cell building off the main thread, eviction of far cells), keyed on the same 350 m cells the server's interest management will use. Measure first; `city.bin` is only 767 KB gzipped.
