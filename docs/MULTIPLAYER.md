# Multiplayer

Players sign up with a name and a password, pick their avatar's colours, walk the city, see everyone else who is online move live, and come back where they left. Guests see the others too, but nobody sees them. Everything runs on our own VM: one Bun process with one SQLite file, behind the nginx that serves the site ([DEPLOY.md](DEPLOY.md)). No third-party services.

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

| Variable             | Default                 | What                                                                                     |
| -------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `PORT`               | `8787`                  | The server listens on 127.0.0.1 only                                                     |
| `DATABASE_PATH`      | `./.data/leuven.sqlite` | One SQLite file for accounts, sessions, outfits and positions; `:memory:` for throwaways |
| `BETTER_AUTH_SECRET` | a fixed dev-only value  | Signs the session cookies. Required when `NODE_ENV=production`: the server won't start   |
| `BETTER_AUTH_URL`    | `http://localhost:5173` | Where the site is served; cookies are `Secure` when it is `https:`                       |
| `TRUSTED_ORIGINS`    | none (dev: localhost)   | More origins allowed to post and connect, comma-separated                                |
| `DEBUG`              | `leuven:*=info`         | [@portable/log](https://portablejs.com/packages/log) patterns, e.g. `leuven:*=debug`     |

## Accounts

better-auth (`server/auth.ts`) does the security work: password hashing (scrypt), session cookies (`HttpOnly`, `SameSite=Lax`, 60 days, renewed daily), rate limits per IP on its routes. It wants an email per account, which players don't have, so each is filed under `<name, lowercased>@players.invalid` (a domain that can never receive mail) and signs in by name through its username plugin.

- A name is 3 to 20 letters, digits, `_`, `-` or `.`, with no dot at either end or two in a row (`src/net/rules.ts`, checked in the browser and on the server). Names are unique whatever their case; the name as typed is what others see.
- A password is 8 to 128 characters.
- Signing up goes through `POST /api/account`, which calls `auth.api.signUpEmail` with the synthetic address and returns better-auth's answer, `Set-Cookie` and all: the player is signed in at once.
- Only a few of better-auth's routes are reachable from outside (`PUBLIC_AUTH_PATHS`): sign in by username, sign out, get the session, change the password, check a name. Signing up by email, changing the name or the address and the rest stay closed.
- A POST from another origin is refused (403), and so is a socket opened from one.
- Limits: 30 accounts made an hour from one address (an IPv6 one by its /64), counting only those made, since a campus shares a few addresses and a taken name is no abuse; better-auth's own per-address limits on signing in; and 10 wrong passwords a quarter of an hour for one name, from anywhere, always on.
- Signing out (or a new password) takes that player's socket off the map (code 4002, `CLOSE_SIGNED_OUT`); the client reconnects as whoever it now is.
- `src/net/account.ts` turns better-auth's error codes into sentences for people: "That name is taken.", "Wrong name or password.", "Use at least 8 characters.", and the like. A sign-in never says which half was wrong.

### Routes

| Route                             | What                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/account`               | `{ username, password }`: creates the account and signs in. 400 with better-auth's `{ code, message }`.                                        |
| `POST /api/auth/sign-in/username` | `{ username, password }`: better-auth's sign-in, sets the cookie                                                                               |
| `POST /api/auth/sign-out`         | Ends the session                                                                                                                               |
| `GET /api/auth/get-session`       | better-auth's session, or null                                                                                                                 |
| `GET /api/me`                     | `{ name, outfit, at }`, or `null` for a guest (a 401 would be logged in their console). `at` is the live position while online, else the saved |
| `PUT /api/me`                     | `{ outfit }`: four 24-bit colours. Saved, and sent to everyone online as `outfit`                                                              |
| `GET /api/health`                 | `{ ok: true, online }`: the number of open sockets                                                                                             |
| `/ws`                             | Presence, below. The session cookie makes it a player; without one it is a guest                                                               |

Every `/api` answer is `Cache-Control: no-store`.

## Presence

One WebSocket per tab, binary frames, codec in `src/net/protocol.ts` (shared by both ends, fully tested; a malformed frame decodes to null and is dropped, never thrown):

| Direction       | Message                               | When                                                      |
| --------------- | ------------------------------------- | --------------------------------------------------------- |
| client → server | `state`                               | The avatar moved (throttled, below)                       |
| server → client | `welcome { you }`                     | First on every connection: your id, 0 for a guest         |
| server → client | `join { id, name, outfit, state }`    | A player's first state, and everyone placed when you join |
| server → client | `states { players: [{ id, state }] }` | Every 100 ms, the players who moved since the last one    |
| server → client | `leave { id }`                        | A placed player disconnected                              |
| server → client | `outfit { id, outfit }`               | A player online saved new colours                         |

A state is `x`, `z` (f32 metres east and south of the city's middle, as `City` has them), `heading` (radians, sent to a 65536th of a turn), `speed` (0 to 25.5 m/s in tenths), `mode` (`foot` or `bike`), `place` (a room id, `''` in the street) and `floor`: 14 bytes and the room id. Ids are per-connection integers for this server run, not account ids; forget them all on `welcome`.

### The server (`server/world.ts`)

- A player is announced with their first state, so nobody appears at a made-up spot.
- Every state is checked: positions are pulled onto the map (`AREA` in `src/data/area.ts`), headings wrapped, speed and floor clamped, an odd room id (`isPlace` in `src/net/rules.ts`, which every id in rooms.json passes) dropped to the street, whose one floor is 0.
- A socket too slow to keep up is closed at its backpressure limit rather than skipped, so it never misses a join or a leave: its client reconnects to everyone as they are.
- Each connection may send 20 messages a second on average, in bursts up to 40 (`@portable/rate-limit`); the rest are dropped. Frames over 1 kB close the socket. Guests' messages are ignored.
- One live connection per account: signing in again elsewhere closes the old socket with code 4001 (`CLOSE_REPLACED`), which the client treats as final instead of fighting back.
- A player's position is saved every 15 s while they move, when they leave, and on shutdown. It comes back as `at` from `/api/me`, standing on foot.
- A new account starts in colours picked from the guests' palettes (`server/outfit.ts`).

### The browser (`src/net/presence.ts`)

```ts
const presence = connectPresence({ onWelcome, onJoin, onLeave, onStates, onOutfit, onStatus });
presence.send(state); // every frame is fine
presence.close();
```

- `send` goes out at most every 100 ms; a change of mode, room or floor, or a jump of more than 4 m, at once; an unchanged state every 3 s as a heartbeat (`src/net/throttle.ts`).
- Nothing is sent while disconnected. The socket reconnects with backoff (1 s up to 15 s, `@portable/websockets`), and the latest state goes first on the new connection.
- Your own id is filtered out of `join` and `states`. `onStatus` reports `connecting`, `online`, `offline` (retrying), `replaced` and `closed`.

### Smoothing (`src/net/interpolate.ts`)

`createSnapshots()` per remote player: `push(performance.now(), state)` on each update, `sample(performance.now())` each frame. It draws 120 ms in the past between the two updates around that moment (position linearly, heading the short way round), runs on for at most 200 ms past the last update if the figure was moving (the way it faces, at the pace it said: two updates a millisecond apart would otherwise stretch into a leap), and jumps instead of gliding when two updates are more than 15 m apart or change room or floor (a door).
