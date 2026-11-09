# Multiplayer

Everyone on the site is on the map: a guest with a random name the server gives them, or a player who signed in with a code sent to their email, picked their avatar's colours, and comes back where they left. Everyone sees everyone else who is online move live, and a person has one figure however many tabs they have open. Everything runs on our own VM: one Bun process with one SQLite file, behind the nginx that serves the site ([DEPLOY.md](DEPLOY.md)). The one third party is [Resend](https://resend.com), which delivers the sign-in codes.

```
browser                                     VM
src/net/account.ts  ── fetch /api/* ──┐     nginx :8000 ── /api/, /ws ──> server/main.ts :8787
src/net/presence.ts ── WebSocket /ws ─┘                                   ├ better-auth (server/auth.ts)
src/net/people.ts (everyone known, smoothed)                              ├ world.ts (presence hub)
                                                                          ├ broadcast.ts (who hears what)
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
| `RESEND_API_KEY`     | none                    | Sends the sign-in codes. Required when `NODE_ENV=production`: the server won't start without it  |
| `MAIL_FROM`          | Resend's test sender    | A sender on a domain verified in Resend, such as `Leuven <hello@leuven.social>`                  |
| `DEBUG`              | `leuven:*=info`         | [@portable/log](https://portablejs.com/packages/log) patterns, e.g. `leuven:*=debug`             |

## Accounts

better-auth (`server/auth.ts`) does the security work: one-time codes (hashed at rest), session cookies (`HttpOnly`, `SameSite=Lax`, 60 days, renewed daily), rate limits per IP on its routes. There are no passwords anywhere: one flow both joins and comes back.

1. **An email**, `POST /api/auth/email-otp/send-verification-otp`. It answers the same whether or not the address has an account, and nothing looks that up.
2. **The six-digit code** it was sent, `POST /api/auth/sign-in/email-otp`. Good for 10 minutes and one use; five wrong tries spend it, and a new one replaces the last. The address's account is signed in, or made if it has none.
3. **Only for a new account, a name.** `GET /api/me` says `fresh: true` until it has been kept or changed with `PUT /api/me { name }`.

- **Every account always has a valid, unique name, so nothing has a half state.** When better-auth creates a user, a `databaseHooks.user.create.before` gives it one: this browser's guest words joined up ("Breezy Kite" becomes `BreezyKite`), or random words without a guest cookie, with a number if taken. A new account is usable at once; `fresh` only asks.
- A name is 3 to 20 letters, digits, `_`, `-` or `.`, with no dot at either end or two in a row (`src/net/rules.ts`, checked in the browser and on the server). Names are unique whatever their case (`username` is lowercased, `name` as typed is what others see). Anything that hands out a name goes through one queue in `server.ts`, since checking it's free and taking it are separate steps. `/api/auth/is-username-available` says while you type.
- `POST /api/auth/email-otp/send-verification-otp` is ours, not better-auth's: its own endpoint swallows a failed send, and a mail that didn't go out has to say so. Ours makes the code with `auth.api.createVerificationOTP` and mails it itself.
- What reaches better-auth is rebuilt from what we checked: the address trimmed and lowercased (and at most 254 characters), the code exactly six digits, and nothing else, so a request can't set a name or an image.
- Only a few of better-auth's routes are reachable from outside (`PUBLIC_AUTH_PATHS`): send a code, sign in with one, sign out, get the session, check a name. The rest stay closed.
- A POST from another origin is refused (403), and so is a socket opened from one.
- **Limits.** Per address, always on, since each guards a person: a code every 30 seconds and 5 an hour for a mailbox (`a+x@b.c` is `a@b.c`'s), and 10 wrong codes a quarter of an hour per address and IP together, so nobody can lock an owner out by guessing; each code gets 5 tries wherever they come from. Per IP (an IPv6 one by its /64), off when `rateLimit` is false: 30 codes an hour (a send the mail provider refused still counts here), 200 codes an hour for the whole server, 30 accounts made an hour, counting only those made since a campus shares a few addresses, and better-auth's own 10 a minute on trying a code. A name changes at most 10 times a minute.
- Signing in turns the browser's guest into the account, and signing out turns it back, on the same socket and figure ("Guests" and "Tabs and devices" below). A new name is told to everyone at once, as `renamed`.
- `src/net/account.ts` turns error codes into sentences for people: "That name is taken.", "That code isn’t right. Check the digits, or send a new one.", and the like.

### Mail

`server/mail.ts` posts to Resend's HTTP API (no SDK) with a timeout and an idempotency key. `main.ts` picks what to do from the environment:

Without `RESEND_API_KEY`, outside production the code is printed on the server's console (`leuven:mail`), so signing in works locally with no account at a provider; in production the server refuses to start, as it does without its secret. With the key and no `MAIL_FROM`, codes go out from Resend's test sender, which delivers only to the Resend account's own address, and the log says so at start.

| Resend answers                                            | The person reads                                                       | The route                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------- |
| 422 about the `to` address                                | "That address can't receive mail. Use another one."                    | 400 `EMAIL_UNDELIVERABLE` |
| 429, a rate or a quota                                    | "Too many emails are going out right now. Try again in a few minutes." | 503 `MAIL_BUSY`           |
| Anything else: an unverified domain, a bad key, a timeout | "Couldn't send the email. Try another address, or try again later."    | 502 `MAIL_FAILED`         |

Every one logs the provider's reason, never the key. A send that failed doesn't count against the mailbox's limits, but does against the sender's address and the server's.

### Accounts from before email

Accounts made with a name and password are filed under `<name>@players.invalid`, which can't receive mail. Their rows are left as they are and their names stay reserved. A session that is still alive carries on until it runs out, but with the password routes gone **they can't sign in again**: a code to a `.invalid` address is refused plainly (400, `EMAIL_UNDELIVERABLE`). Nothing here deletes them; bringing one back would mean giving its row a real address.

### Guests

Not signed in, you are on the map all the same, as a guest. A guest is a signed cookie and nothing else:

- **`leuven_guest`** is `HttpOnly`, `SameSite=Lax`, `Secure` on https, and holds a random 128-bit id with its HMAC-SHA-256 under `BETTER_AUTH_SECRET` (`server/guest.ts`). A forged or altered one counts as none and the browser gets a new guest. `GET /api/me` sets it (or renews it), and so does a socket that came without one.
- **The name and look are worked out from the id**, so the page can neither pick nor change them and the same browser is the same guest across reloads and tabs. The name is two words, "Sunny Otter", and has a space, which no account's name can (`isUsername` in `src/net/rules.ts`), so a guest can't pass for an account. Two guests online can draw the same two words: the hub adds a number to the later one ("Sunny Otter 2").
- **Nothing is stored.** No account row, no table, nothing to clean up: a guest ends when their cookie does, 30 days after their last visit (every visit renews it). Where one last stood is kept in the hub's memory for 10 minutes, for a reload or a short break, 2048 of them at most; a server restart forgets it.
- A guest's look and name can't be changed: choosing them is what an account is for (`PUT /api/me` answers 401).
- **Abuse:** each address (an IPv6 one by its /64, as for new accounts) has at most 12 guests on the map, on top of nginx's 16 sockets an address ([DEPLOY.md](DEPLOY.md)). Over that, a guest is admitted and sees everyone but isn't placed: `identity` says `unseen` and the sheet tells them; joining puts them on the map. The cap is off when `rateLimit` is false, as in tests.

### Tabs and devices

**A person is one figure on the map, however many tabs and devices they have open** (a guest by their cookie, a player by their account). Every tab keeps its own socket and its own view of the map, and hears everyone as usual.

- **Exactly one tab moves the figure: the driver.** A person's first tab drives. A tab takes over when someone uses it: focus, a press or a key, or being shown (`drive`). The server ignores states from any other tab, and it tells the tab that lost the drive (`driving` off) and the one that got it (`driving` on).
- **A tab never claims in reply to anything the server or another tab said.** A claim only follows a person's hand, so two tabs can't pass the figure back and forth. No tab is closed for being a second tab, and `4001` is gone.
- A tab that isn't driving follows the figure: the server sends it `placed` with its own id as the figure moves, and it stands its avatar there at most 5 times a second (hidden tabs catch up when shown; a tab that was behind hears the figure's latest position once it has caught up, as a recount says nothing of its own figure). Should it take over, it carries on from there, so the figure doesn't jump.
- When the driver closes, the newest tab left takes over. A figure leaves the map when its last tab does.
- A person has at most 16 tabs; the next is turned away with 1008, which the client doesn't retry, never an older tab.
- **Signing in or out reaches every tab of that browser through its own socket**, no reload and no reconnect. The auth route reads the browser's cookies and rebinds its sockets in the hub: the guest's figure is renamed the account in place (others hear `renamed`; there is no leave and no join), and each tab hears `identity`. If the account is already on the map (another device), the tabs join that figure instead and the guest's figure leaves.
- **Signing out ends one session.** The tabs on that session become the browser's guest again, in place, while the same player's other devices stay signed in as the one figure. The guest cookie stays put while signed in, so it is the same guest as before.
- A sign-in or -out that a tab's socket didn't get (a socket opened in the instant before a first cookie landed) is noticed: after 1.5 s the page reconnects, and the server says who it is now. Two tabs opened at the same moment on a first-ever visit can briefly be two guests; they meet on the next reload.
- Signing in carries on where you stand, under the account's name; a saved position is where a _visit_ starts. A new account wears the guest's look.

### Routes

| Route                                            | What                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/email-otp/send-verification-otp` | `{ email }`: mails a code. `{ success: true }`; 429 with `retryAfter` (`CODE_ALREADY_SENT`) inside the 30 seconds; 429 `TOO_MANY_CODES`; 503 `MAIL_BUSY`; 502 `MAIL_FAILED`; 400 `INVALID_EMAIL` or `EMAIL_UNDELIVERABLE`                 |
| `POST /api/auth/sign-in/email-otp`               | `{ email, otp }`: signs in, making the account if there is none; sets the cookie. 400 `INVALID_OTP` or `OTP_EXPIRED`, 403 `TOO_MANY_ATTEMPTS`                                                                                             |
| `POST /api/auth/is-username-available`           | `{ username }`: `{ available }`                                                                                                                                                                                                           |
| `POST /api/auth/sign-out`                        | Ends the session                                                                                                                                                                                                                          |
| `GET /api/auth/get-session`                      | better-auth's session, or null                                                                                                                                                                                                            |
| `GET /api/me`                                    | `{ guest, name, outfit, at, fresh }`: the account (`fresh`: yet to choose its name), or this browser's guest and its cookie (`mail`: whether codes can be sent). `at` is the live position while online, else the saved or remembered one |
| `PUT /api/me`                                    | `{ outfit }`: four 24-bit colours, sent to everyone online as `outfit`; or `{ name }`: takes it if free (400 `USERNAME_IS_ALREADY_TAKEN`), sent as `renamed`. 401 for a guest                                                             |
| `GET /api/health`                                | `{ ok: true, online, players, tickMs, tickMaxMs, bytesPerSecond }`: open sockets, those on the map, and how the presence hub is doing                                                                                                     |
| `/ws`                                            | Presence, below. The session cookie makes it a player; without one it is this browser's guest (and sets the cookie if there is none)                                                                                                      |

Every `/api` answer is `Cache-Control: no-store`.

## Presence

One WebSocket per tab, binary frames, codec in `src/net/protocol.ts` (shared by both ends, fully tested; a malformed frame decodes to null and is dropped, never thrown):

| Direction       | Message                                    | When                                                                                                             |
| --------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| client → server | `state`                                    | The avatar moved (throttled, below)                                                                              |
| client → server | `view { x, z, reach }`                     | The map looks somewhere else, or zooms (40 m, another cell, or 12% more reach; at most 4 a second)               |
| client → server | `drive`                                    | This tab is in use: it moves the figure from now on                                                              |
| server → client | `welcome { you }`                          | First on every connection: your figure's id                                                                      |
| server → client | `identity { guest, unseen, name, outfit }` | Who this connection is: on connecting, and whenever it changes (signing in or out in any tab)                    |
| server → client | `driving { on }`                           | Whether this tab moves the figure                                                                                |
| server → client | `tick`                                     | Every 100 ms, what changed for you, in one frame: leaves, demotes, joins, near moves, far moves                  |
| server → client | `coarse`                                   | Once a second (and at once when your interest changes): everyone in the street round your view, by cell          |
| server → client | `placed { id, state }`                     | A figure went through a door or changed floor; with your own id, where your figure went, driven from another tab |
| server → client | `renamed { id, name, outfit }`             | A figure someone can see became someone else, signed in or out, or took a new name, in place                     |
| server → client | `outfit { id, outfit }`                    | A player you can see saved new colours                                                                           |
| server → client | `online { count }`                         | How many are on the map, once a second when it changed                                                           |

A client's own `state` is `x`, `z` (f32 metres east and south of the city's middle, as `City` has them), `heading` (radians, sent to a 65536th of a turn), `speed` (0 to 25.5 m/s in tenths), `mode` (`foot` or `bike`), `place` (a room id, `''` in the street) and `floor`: 14 bytes and the room id. `view` is `x`, `z` and `reach` (u16, metres the view shows either way, 0 for a tab nobody can see; an old 8-byte view reads as a street-level one).

A `tick` entry is 9 bytes: a varint id, `x` and `z` as 16-bit offsets across a 3×3 of cells (1.6 cm a step), the heading, and the speed in fifths of a m/s with the mode in its top bit. For a figure among your 32 nearest it is a delta after the first: the same id, how far it went in those steps (a byte each way, up to 2 m), and the heading and speed only when they changed, about 5 bytes. The socket is reliable and ordered, so the baseline is simply the last move sent; the server forgets it whenever a client could have missed one (a leave, a recount). A `coarse` entry is an id, two bytes of a cell (1.4 m) and a colour in RGB565. Ids are per-figure integers, shared by all a person's tabs and used again once everyone has heard the last holder left; forget them all on `welcome`.

### The server (`server/world.ts`, `server/broadcast.ts`)

`world.ts` is who is who: figures, tabs, identity, validation, saving. A figure is announced with its first state, so nobody appears at a made-up spot. `broadcast.ts` is what they hear, in flat arrays indexed by figure id:

- **Fine interest is the 3×3 of 350 m cells (`src/net/interest.ts`) round where the map looks, and only while its reach is at most `FINE_REACH`, 350 m.** A look that has crossed into the next cell keeps its old 3×3 until it is 40 m past the edge, so wandering along a line doesn't resend three columns of people. Fine means by name and in clothes: `joins`, moves, `placed`, `renamed`, `outfit`.
- **Coarse interest is the cells the view reaches (look ± reach) plus the 3×3 round your own figure (the minimap's), minus the fine ones**: a spot and a shirt, for everyone in the street, a second apart. Someone leaving your fine interest who is still in your coarse interest is `demote`d in the same frame, the same person going on in place; otherwise it is a `leave`. `reach` 0 is a hidden tab: no interest at all, just `online`, `identity` and its own `placed`.
- **A `tick` is one frame per client per round**: leaves, demotes, joins (nearest first, paged to 16 kB, the rest next tick, and fewer when your socket has much queued), near moves, then far moves. The 32 nearest of a client move every round, in deltas; their list is worked out again every 5th round, on the client's own turn, not on everyone's at once, by rings out from its look through the 25 m squares each cell is filed in once a tick, stopping as soon as nobody further out could make the list (so it stays exact; `walkRings`, with a plain scan when the 3×3 is thin). Everyone else in fine interest takes turns: a figure's turn is `(id + round) % 10`, the same for whoever is listening, so a cell's far movers are encoded once and copied into each frame that wants them. A cell so full its movers wouldn't fit gets a longer turn rather than dropping anyone, so a figure that stopped between its turns is always told of on its next one. A client that is recounting hears no moves, so nothing in the cells it watches uses up its turn until the recount has ended: a stop that fell inside the recount goes out after it.
- **`coarse` frames are built per cell once a second and shared**: cell, total in the street, weight, then the people. A crowded cell is sampled by `id % weight`, weight a power of two, so doubling it keeps half of who was shown, at most 256 a cell at reach up to 1225 m and 64 beyond. A client's frame is its whole coarse interest, in pages if need be (`first`/`last`); absence means gone. It goes out on the client's own turn in the second, and on the next tick whenever its interest changes (a zoom out shows the crowd at once, not a second later), with fine cells included while joins are still paging so no one blinks out between one and the other. An empty frame is skipped unless the client could be holding someone coarsely (it heard a demote, or a coarse page with anybody in it, since its last empty frame), so a street with nobody in it costs nothing and nobody is left drawn.
- The tick is cut in two 50 ms slices, each writing to half the clients: a thousand socket writes in one go is what takes the time. Join bytes are encoded once per figure and copied into each frame (the numbers written over at most once a tick, re-encoded when a name, outfit, room or floor changes); `ranked` sorts only a page's worth by true distance. Each slice may look through 1 million figures (`WORK_PER_SLICE`) to work out near lists, recounts and who a look that moved must hear of, and write 8 MB of joins over all clients (`JOIN_BYTES_PER_SLICE`); a storm past that waits for the next tick.
- **A client too slow to keep up is skipped, not wiped.** With 64 kB queued it hears nothing until it is down to 8 kB, then gets a **recount**: everyone it can see, nearest first, paged through the same 16 kB joins of ordinary ticks and paced by what is queued (no join goes out that would put it back over the 64 kB), with no moves until it is done; a stop that fell inside it goes out once it has ended, as above. `beginRecount`/`endRecount` in `src/net/people.ts` reconcile by id, so nobody it still has is dropped or fades. The old recovery sent everyone at once and fell behind again the moment it recovered; this one can't. Only a socket that has stopped reading is closed, at 1 MB queued.
- Every state is checked: positions are pulled onto the map (`AREA` in `src/data/area.ts`), headings wrapped, speed and floor clamped, an odd room id (`isPlace` in `src/net/rules.ts`, which every id in rooms.json passes) dropped to the street, whose floors are 0 and 1, the ground and the one level of decks and tunnels (`levelAt` in `src/data/walkable.ts`). A figure can't get further between two messages than 30 m/s for the time since the last one (up to 5 s of it) plus 8 m; a door, a change of room or of floor inside one, is the one thing that moves it at once. A walker steps between the street's floors at no distance, so that is a step like any other, not a door.
- Each connection may send 20 messages a second on average, in bursts up to 40 (`@portable/rate-limit`); the rest are dropped. Frames over 1 kB close the socket.
- A guest's position is never saved. A player's position is saved every 15 s while they move, when they leave, and on shutdown, each tick's in one SQLite transaction after the frames have gone out. It comes back as `at` from `/api/me`, standing on foot.
- A new account starts in colours picked from the same palettes as a guest's look (`server/outfit.ts`), or, when it was a guest a moment ago, in the look it had.
- One output buffer is reused for every frame, and compression is off: a tick's bytes were spent on the far movers, encoded once, not on deflate per socket.

### Load (`bun scripts/swarm.ts --bots 1000`)

Guests on real sockets, walking at 10 Hz (their positions aren't saved, so these runs don't include SQLite's writes), each saying it comes from one of a few addresses so the guest cap doesn't hide them. `--zoomed-out 0.3` makes that share look at the whole city (reach 3 km) from the street bots' middle; the others say where they look as they walk, reach 180 m.

Compared with the earlier, per-kind frames (one frame each for leaves, joins and moves, every client's deltas computed on every tick), on the MacBook (M4), 1000 bots, 2 slices:

|                           | Across the city (before) | Across the city (now) | All within 90 m (before) | All within 90 m (now) | Whole city, 30% zoomed out (now) |
| ------------------------- | ------------------------ | --------------------- | ------------------------ | --------------------- | -------------------------------- |
| Per client, on the street | 3.6 KB/s                 | 3.9 KB/s              | 10.5 KB/s                | 10.6 KB/s             | 3.9 KB/s                         |
| Per client, zoomed out    | not possible             | n/a                   | not possible             | n/a                   | 6.0 KB/s                         |
| Frames per client, per s  | not measured             | 9.9                   | not measured             | 9.7                   | 7.2                              |
| Out of the server         | 3.5 MB/s                 | 3.8 MB/s              | 10.2 MB/s                | 10.3 MB/s             | 4.4 MB/s                         |
| Mean tick (one slice)     | 11 ms                    | 6.2 ms                | 20 ms                    | 7.6 ms                | 3.3 ms                           |
| Longest tick              | not measured             | 8 ms                  | not measured             | 8 ms                  | 8 ms                             |
| Server CPU, one core      | 29%                      | 19%                   | 46%                      | 20%                   | 11%                              |

With everyone inside 90 m, a zoomed-out client gets the whole crowd sampled to 64 people: 0.66 KB/s. Bots turn on every step, so each delta carries a heading: a person walking straight costs less.

Those numbers are from a quiet machine. With the shared crowd work below (fine squares, cached joins, bounded storms) and another 400-bot server running alongside, the MacBook (M4) did this, old and new code A/B on the same machine and in the same minutes (mean tick over 1000 bots, 2 slices, 12 s runs; per-client traffic within 0.1 KB/s of the table):

|                            | Before  | After   |
| -------------------------- | ------- | ------- |
| Across the city            | 9.1 ms  | 8.8 ms  |
| All within 90 m            | 12.3 ms | 10.7 ms |
| Whole city, 30% zoomed out | 8.8 ms  | 8.5 ms  |

### Dense crowds

Crowds run in one process with the sockets stubbed out, 40 rounds of everyone walking after a 4-round warm-up. Each client is its own view of a crowd; "recount" is 1500 of them recovering in the same slice:

|                                         | Before                   | After                    |
| --------------------------------------- | ------------------------ | ------------------------ |
| 1000 in one crowd, mean / longest slice | 5.7 / 7.7 ms             | 3.9 / 6.0 ms             |
| 2000 in one crowd                       | 19.1 / 31 ms             | 14.8 / 36 ms             |
| 4000 in one crowd                       | 131.8 / 1051 ms          | 35.4 / 51 ms             |
| 3000 and 64 clients flipping their look | 28.1 / 75 ms             | 14.8 / 25 ms             |
| 1500 clients all recounting at once     | 316, 303, 121, 121, … ms | 28, 28, 23, 23, 16, … ms |

4000 on a single spot (all within a 20 m square), the worst case for finding who is nearest, runs at about 31 ms a slice, 43 ms at the longest: there the work budget runs out and near lists are worked out every second or so instead of every half second. Near lists stay exact (a client's own rings, not an answer shared by square): a list shared per 25 m square would have saved little here and cost up to 17 m of error in exactly the dense places it would apply. What is given up is ordering beyond the first page of a join burst: the first 512 joins are in true order, the rest in 25 m rings.

### The browser (`src/net/presence.ts`)

```ts
const people = createPeople();
const presence = connectPresence({
  people,
  onNews,
  onWelcome,
  onIdentity,
  onOwn,
  onOwnOutfit,
  onOnline,
  onStatus,
  inUse,
});
presence.send(state); // every frame is fine; goes out only while this tab drives
presence.view(x, z, reach); // as the view changes
presence.drive(); // this tab is in use
presence.close();
```

- `send` goes out at most every 100 ms; a change of mode, room or floor, or a jump of more than 4 m, at once; an unchanged state every 3 s as a heartbeat (`src/net/throttle.ts`).
- `view` says where the map looks and how far: at most 4 a second, and only after 40 m, a new cell, 12% more reach or crossing `FINE_REACH`. It is sent first on each new connection, before any state.
- Moves are read straight into `people` through `readTick`'s sink (no objects per mover) with deltas against each figure's own baseline; a `tick` and a `coarse` page call `people` and then `onNews`. `onWelcome` is that `people` was forgotten, ids being per connection.
- Nothing is sent while disconnected. The socket reconnects with backoff (1 s up to 15 s, `@portable/websockets`). A tab in use (`inUse`: visible and focused) claims the figure as soon as the socket opens and sends its latest state first; any other waits for `driving` and goes on from where the figure is. The others stand frozen for 5 s (`people` keeps them) and then go, unless the socket came back meanwhile, and everyone is known afresh on `welcome`.
- Your own id is filtered out of `tick`, `coarse`; a far block is shared and carries your own turn too, read past. `onStatus` reports `connecting`, `online`, `offline` (retrying) and `closed`.

### Smoothing

`src/net/people.ts` is the one list of everyone known, in flat arrays so a frame of thousands allocates nothing, and every drawing of them reads it (the street, the markers, the minimap, the full map). `Roster` is what the scene gets: the list, `look(x, z, reach)` going back to the server and a coalesced `listen`. Someone known in full (`join`, `move`) or coarsely (`coarse`, about 1 Hz) is drawn a moment behind the network between two updates, by an offset per person that follows how often they are heard, on a playhead that only moves forward; coming and going is a fade, and the same person moves between full and coarse in place, without a pop (`demote` keeps them for coarse frames to take over; a `recount` confirms them by id). A door is a jump, not a glide.
