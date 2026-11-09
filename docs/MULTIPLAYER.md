# Multiplayer

Everyone on the site is on the map: a guest with a random name the server gives them, or a player who signed up with a name and a password, picked their avatar's colours, and comes back where they left. Everyone sees everyone else who is online move live, and a person has one figure however many tabs they have open. Everything runs on our own VM: one Bun process with one SQLite file, behind the nginx that serves the site ([DEPLOY.md](DEPLOY.md)). No third-party services.

```
browser                                     VM
src/net/account.ts  ── fetch /api/* ──┐     nginx :8000 ── /api/, /ws ──> server/main.ts :8787
src/net/presence.ts ── WebSocket /ws ─┘                                   ├ better-auth (server/auth.ts)
src/net/interpolate.ts (smoothing)                                        ├ world.ts (presence hub)
                                                                          └ store.ts ── leuven.sqlite
```

The page talks to its own origin only, so the session cookie needs no CORS and the socket goes to `wss://<host>/ws` (`ws:` on an `http:` page). In dev Vite proxies `/api` and `/ws` to the server the same way.

## Running it locally

```bash
bun run dev          # Vite on :5173 and the server on :8787 (restarts on change), together
bun run dev:server   # the server alone
```

The database is `./.data/leuven.sqlite` (gitignored); delete it to start over. better-auth's tables and ours are created on start, so a fresh file just works. Open http://localhost:5173: the server's `BETTER_AUTH_URL` defaults to that origin, and outside production `localhost` and `127.0.0.1` on any port are trusted too, for when Vite moves to another port or for `bun run preview`. From another device on the network, add its origin, e.g. `TRUSTED_ORIGINS=http://192.168.1.20:5173 bun run dev`.

| Variable             | Default                 | What                                                                                             |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `PORT`               | `8787`                  | The server listens on 127.0.0.1 only                                                             |
| `DATABASE_PATH`      | `./.data/leuven.sqlite` | One SQLite file for accounts, sessions, outfits and positions; `:memory:` for throwaways         |
| `BETTER_AUTH_SECRET` | a fixed dev-only value  | Signs the session and guest cookies. Required when `NODE_ENV=production`: the server won't start |
| `BETTER_AUTH_URL`    | `http://localhost:5173` | Where the site is served; cookies are `Secure` when it is `https:`                               |
| `TRUSTED_ORIGINS`    | none (dev: localhost)   | More origins allowed to post and connect, comma-separated                                        |
| `DEBUG`              | `leuven:*=info`         | [@portable/log](https://portablejs.com/packages/log) patterns, e.g. `leuven:*=debug`             |

## Accounts

better-auth (`server/auth.ts`) does the security work: password hashing (scrypt), session cookies (`HttpOnly`, `SameSite=Lax`, 60 days, renewed daily), rate limits per IP on its routes. It wants an email per account, which players don't have, so each is filed under `<name, lowercased>@players.invalid` (a domain that can never receive mail) and signs in by name through its username plugin.

- A name is 3 to 20 letters, digits, `_`, `-` or `.`, with no dot at either end or two in a row (`src/net/rules.ts`, checked in the browser and on the server). Names are unique whatever their case; the name as typed is what others see.
- A password is 8 to 128 characters.
- Signing up goes through `POST /api/account`, which calls `auth.api.signUpEmail` with the synthetic address and returns better-auth's answer, `Set-Cookie` and all: the player is signed in at once.
- Only a few of better-auth's routes are reachable from outside (`PUBLIC_AUTH_PATHS`): sign in by username, sign out, get the session, change the password, check a name. Signing up by email, changing the name or the address and the rest stay closed.
- A POST from another origin is refused (403), and so is a socket opened from one.
- Limits: 30 accounts made an hour from one address (an IPv6 one by its /64), counting only those made, since a campus shares a few addresses and a taken name is no abuse; better-auth's own per-address limits on signing in; and 10 wrong passwords a quarter of an hour for one name, from anywhere, always on.
- Signing up or in turns the browser's guest into the account, and signing out turns it back, on the same socket and figure ("Guests" and "Tabs and devices" below). A new password closes every socket of that player instead (code 4002, `CLOSE_SIGNED_OUT`); they reconnect as whoever they now are.
- `src/net/account.ts` turns better-auth's error codes into sentences for people: "That name is taken.", "Wrong name or password. Check both and try again.", "Use at least 8 characters.", and the like. A sign-in never says which half was wrong.

### Guests

Not signed in, you are on the map all the same, as a guest. A guest is a signed cookie and nothing else:

- **`leuven_guest`** is `HttpOnly`, `SameSite=Lax`, `Secure` on https, and holds a random 128-bit id with its HMAC-SHA-256 under `BETTER_AUTH_SECRET` (`server/guest.ts`). A forged or altered one counts as none and the browser gets a new guest. `GET /api/me` sets it (or renews it), and so does a socket that came without one.
- **The name and look are worked out from the id**, so the page can neither pick nor change them and the same browser is the same guest across reloads and tabs. The name is "Guest Sunny Otter": it says what it is, and has spaces, which no account's name can (`isUsername` in `src/net/rules.ts`). Two guests online can draw the same two words: the hub adds a number to the later one ("Guest Sunny Otter 2").
- **Nothing is stored.** No account row, no table, nothing to clean up: a guest ends when their cookie does, 30 days after their last visit (every visit renews it). Where one last stood is kept in the hub's memory for 10 minutes, for a reload or a short break, 2048 of them at most; a server restart forgets it.
- A guest's look can't be changed: choosing a look is what an account is for (`PUT /api/me` answers 401).
- **Abuse:** each address (an IPv6 one by its /64, as for sign-ups) has at most 12 guests on the map, on top of nginx's 16 sockets an address ([DEPLOY.md](DEPLOY.md)). Over that, a guest is admitted and sees everyone but isn't placed: `identity` says `unseen` and the sheet tells them; joining puts them on the map. The cap is off when `rateLimit` is false, as in tests.

### Tabs and devices

**A person is one figure on the map, however many tabs and devices they have open** (a guest by their cookie, a player by their account). Every tab keeps its own socket and its own view of the map, and hears everyone as usual.

- **Exactly one tab moves the figure: the driver.** A person's first tab drives. A tab takes over when someone uses it: focus, a press or a key, or being shown (`drive`). The server ignores states from any other tab, and it tells the tab that lost the drive (`driving` off) and the one that got it (`driving` on).
- **A tab never claims in reply to anything the server or another tab said.** A claim only follows a person's hand, so two tabs can't pass the figure back and forth. No tab is closed for being a second tab, and `4001` is gone.
- A tab that isn't driving follows the figure: the server sends it `placed` with its own id as the figure moves, and it stands its avatar there at most 5 times a second (hidden tabs catch up when shown). Should it take over, it carries on from there, so the figure doesn't jump.
- When the driver closes, the newest tab left takes over. A figure leaves the map when its last tab does.
- A person has at most 16 tabs; the next is turned away with 1008, which the client doesn't retry, never an older tab.
- **Signing in or out reaches every tab of that browser through its own socket**, no reload and no reconnect. The auth route reads the browser's cookies and rebinds its sockets in the hub: the guest's figure is renamed the account in place (others hear `renamed`; there is no leave and no join), and each tab hears `identity`. If the account is already on the map (another device), the tabs join that figure instead and the guest's figure leaves.
- **Signing out ends one session.** The tabs on that session become the browser's guest again, in place, while the same player's other devices stay signed in as the one figure. The guest cookie stays put while signed in, so it is the same guest as before.
- A sign-in or -out that a tab's socket didn't get (a socket opened in the instant before a first cookie landed) is noticed: after 1.5 s the page reconnects, and the server says who it is now. Two tabs opened at the same moment on a first-ever visit can briefly be two guests; they meet on the next reload.
- Signing in carries on where you stand, under the account's name; a saved position is where a _visit_ starts. A new account wears the guest's look.

### Routes

| Route                             | What                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/account`               | `{ username, password }`: creates the account and signs in. 400 with better-auth's `{ code, message }`.                                                        |
| `POST /api/auth/sign-in/username` | `{ username, password }`: better-auth's sign-in, sets the cookie                                                                                               |
| `POST /api/auth/sign-out`         | Ends the session                                                                                                                                               |
| `GET /api/auth/get-session`       | better-auth's session, or null                                                                                                                                 |
| `GET /api/me`                     | `{ guest, name, outfit, at }`: the account, or this browser's guest (and its cookie). `at` is the live position while online, else the saved or remembered one |
| `PUT /api/me`                     | `{ outfit }`: four 24-bit colours. Saved, and sent to everyone online as `outfit`; 401 for a guest                                                             |
| `GET /api/health`                 | `{ ok: true, online, players, tickMs, tickMaxMs, bytesPerSecond }`: open sockets, those on the map, and how the presence hub is doing                          |
| `/ws`                             | Presence, below. The session cookie makes it a player; without one it is this browser's guest (and sets the cookie if there is none)                           |

Every `/api` answer is `Cache-Control: no-store`.

## Presence

One WebSocket per tab, binary frames, codec in `src/net/protocol.ts` (shared by both ends, fully tested; a malformed frame decodes to null and is dropped, never thrown):

| Direction       | Message                                    | When                                                                                                             |
| --------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| client → server | `state`                                    | The avatar moved (throttled, below)                                                                              |
| client → server | `view { x, z }`                            | The map looks somewhere else (40 m or another cell, at most 4 a second)                                          |
| client → server | `dots { on }`                              | The full map opened or shut                                                                                      |
| client → server | `drive`                                    | This tab is in use: it moves the figure from now on                                                              |
| server → client | `welcome { you }`                          | First on every connection: your figure's id                                                                      |
| server → client | `identity { guest, unseen, name, outfit }` | Who this connection is: on connecting, and whenever it changes (signing in or out in any tab)                    |
| server → client | `driving { on }`                           | Whether this tab moves the figure                                                                                |
| server → client | `joins { players }`                        | Who came into what you hear of, in one frame a tick                                                              |
| server → client | `leaves { ids }`                           | Who went out of it, gone or further off                                                                          |
| server → client | `moves { cx, cz, players }`                | Every 100 ms, those who moved since the last one                                                                 |
| server → client | `placed { id, state }`                     | A figure went through a door or changed floor; with your own id, where your figure went, driven from another tab |
| server → client | `renamed { id, name, outfit }`             | A figure someone can see became someone else, signed in or out, in place                                         |
| server → client | `outfit { id, outfit }`                    | A player you can see saved new colours                                                                           |
| server → client | `online { count }`                         | How many are on the map, once a second when it changed                                                           |
| server → client | `dots { players }`                         | Everyone on the map, every 2 s while the full map is open                                                        |

A client's own `state` is `x`, `z` (f32 metres east and south of the city's middle, as `City` has them), `heading` (radians, sent to a 65536th of a turn), `speed` (0 to 25.5 m/s in tenths), `mode` (`foot` or `bike`), `place` (a room id, `''` in the street) and `floor`: 14 bytes and the room id. A `moves` entry is 9 bytes: a varint id, `x` and `z` as 16-bit offsets across the 3×3 cells round (`cx`, `cz`) (1.6 cm a step), the heading, and the speed in fifths of a m/s with the mode in its top bit. For a figure among the 32 nearest it is a delta after the first: the same id, how far it went in those steps (a byte each way, up to 2 m), and the heading and speed only when they changed, about 5 bytes. The socket is reliable and ordered, so the baseline is simply the last move sent; the server forgets it whenever a client could have missed one (a leave, a join, `welcome` after falling behind, a turn that went whole). Ids are per-figure integers, shared by all a person's tabs and used again once everyone has heard the last holder left; forget them all on `welcome`.

### The server (`server/world.ts`)

- A person is one figure, whatever is driving it (`Figure` in world.ts, beside `Client`, a socket). A figure is announced with its first state, so nobody appears at a made-up spot.
- **Each client hears only of the 3×3 of 350 m cells (`src/net/interest.ts`, the renderer's own) round where its map looks**: what it said with `view`, else its own figure, else the city's middle. That is at least 350 m of street on every side, further than a figure is drawn. A join or a leave is someone crossing into or out of those cells, or the client looking elsewhere; arriving and leaving in the same tick says nothing. Everyone else is a count (`online`) and, while the full map is open, a dot (`dots`).
- **In a crowd, the nearest move at full rate, the rest in turns.** Each tick a client hears of the 32 movers nearest what it looks at and, of the others, those whose turn it is, once a second each, at most 160 in a frame. A figure that stopped between its turns is told of on its next one.
- Everything for a client goes out in one go each tick: leaves, joins, moves. Doors go first, so a figure's jump is one jump.
- The tick is cut in two 50 ms slices, each writing to half the clients: a thousand socket writes in one go is what takes the time.
- Every state is checked: positions are pulled onto the map (`AREA` in `src/data/area.ts`), headings wrapped, speed and floor clamped, an odd room id (`isPlace` in `src/net/rules.ts`, which every id in rooms.json passes) dropped to the street, whose one floor is 0. A figure can't get further between two messages than 30 m/s for the time since the last one (up to 5 s of it) plus 8 m; a door, a change of room or floor, is the one thing that moves it at once.
- A client too slow to keep up is skipped, not cut off: with 64 kB queued it hears nothing until it is down to 8 kB, then starts over (`welcome`, and everyone it can see as they are). Only a socket that has stopped reading is closed, at 1 MB queued.
- Each connection may send 20 messages a second on average, in bursts up to 40 (`@portable/rate-limit`); the rest are dropped. Frames over 1 kB close the socket.
- A guest's position is never saved. A player's position is saved every 15 s while they move, when they leave, and on shutdown, each tick's in one SQLite transaction after the frames have gone out. It comes back as `at` from `/api/me`, standing on foot.
- A new account starts in colours picked from the same palettes as a guest's look (`server/outfit.ts`), or, when it was a guest a moment ago, in the look it had.

### Load (`bun scripts/swarm.ts --bots 1000`)

Real accounts on real sockets, walking at 10 Hz. On the MacBook (M4), 1000 bots:

|                       | Everyone to everyone (before) | Across the city (now) | All within 90 m (now) |
| --------------------- | ----------------------------- | --------------------- | --------------------- |
| Per client            | 153 KB/s                      | 3.6 KB/s              | 10.5 KB/s             |
| Out of the server     | 150 MB/s (1.2 Gbit/s)         | 3.5 MB/s              | 10.2 MB/s             |
| Mean tick (one slice) | not measured                  | 11 ms                 | 20 ms                 |
| Server CPU, one core  | 19%                           | 29%                   | 46%                   |

Bots turn on every step, so each delta carries a heading: a person walking straight costs less.

### The browser (`src/net/presence.ts`)

```ts
const presence = connectPresence({
  onWelcome,
  onIdentity,
  onRenamed,
  onOwn,
  onJoin,
  onLeave,
  onStates,
  onOutfit,
  onStatus,
  inUse,
});
presence.send(state); // every frame is fine; goes out only while this tab drives
presence.drive(); // this tab is in use
presence.close();
```

- `send` goes out at most every 100 ms; a change of mode, room or floor, or a jump of more than 4 m, at once; an unchanged state every 3 s as a heartbeat (`src/net/throttle.ts`).
- `view` says where the map looks: at most 4 a second, and only after 40 m or a new cell. It is sent first on each new connection, before any state.
- Nothing is sent while disconnected. The socket reconnects with backoff (1 s up to 15 s, `@portable/websockets`). A tab in use (`inUse`: visible and focused) claims the figure as soon as the socket opens and sends its latest state first; any other waits for `driving` and goes on from where the figure is. The others stand frozen for 5 s and then go, unless the socket came back meanwhile, and everyone is known afresh on `welcome`.
- Your own id is filtered out of `joins`, `moves` and `dots`. `onStatus` reports `connecting`, `online`, `offline` (retrying) and `closed`.

### Smoothing (`src/net/interpolate.ts`)

`createSnapshots()` per remote player: `push(performance.now(), state)` on each update, `sample(performance.now(), out)` each frame, written into `out`, so a frame of a crowd allocates nothing. It draws 120 ms in the past between the two updates around that moment (position linearly, heading the short way round), runs on past the last update if the figure was moving (the way it faces, at the pace it said: two updates a millisecond apart would otherwise stretch into a leap) for 200 ms, or about as long as the last gap between updates up to 1.5 s (in a crowd a far figure is told of once a second), and jumps instead of gliding when two updates are more than 15 m apart or change room or floor (a door).
