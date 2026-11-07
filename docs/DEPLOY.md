# Deploy

The app is a static build and a small multiplayer server ([MULTIPLAYER.md](MULTIPLAYER.md)), published to an [exe.dev](https://exe.dev) VM at **https://leuven.exe.xyz/**.

```bash
bun run deploy            # build, upload, go live on the VM "leuven"
bun run deploy my-vm      # the same, to https://my-vm.exe.xyz/
```

It needs an SSH key that is registered with exe.dev (`ssh exe.dev ls` works). The `using-exe-dev` skill in `.agents/skills/` covers signup and the exe.dev CLI.

## What `scripts/deploy.ts` does

Each step is safe to repeat, so a rerun is also how you repair a VM.

1. Runs `bun run build` (the site, `dist/`) and `bun run build:server` (the server in one file, `dist-server/main.js`).
2. Creates the VM with `ssh exe.dev new` if it doesn't exist yet.
3. Installs Bun into `/opt/bun` unless it is already the version in `package.json`'s `packageManager`, so the server runs on the Bun it was tested with.
4. Streams both builds over SSH into `/srv/leuven/releases/<time>-<commit>/` (`site/` and `server/main.js`), then points the `/srv/leuven/current` symlink at it in one rename. The last three releases are kept.
5. Sets up the server once: a system user `leuven`, the data directory `/srv/leuven/data` (the SQLite database, owned by that user) and `/srv/leuven/data/server.env` with a freshly generated `BETTER_AUTH_SECRET`. The env file is never rewritten: a new secret would sign everyone out. Then it writes the systemd unit `leuven-server.service` if it changed, restarts the service on every deploy and waits for `/api/health` on the VM.
6. Writes the nginx site (preinstalled on exe.dev's default image) and reloads nginx only if the config changed. nginx is enabled as a systemd service, so it comes back after a reboot.
7. Points exe.dev's HTTPS proxy at port 8000 and makes it public (`ssh exe.dev share port|set-public`).
8. Fetches the live site and fails if the cache headers below are wrong or `/api/health` doesn't answer.

## On the VM

| Path or unit                     | What                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/srv/leuven/current/site/`      | What nginx serves                                                                                       |
| `/srv/leuven/current/server/`    | `main.js`, run by `leuven-server.service` as the user `leuven`, restarted on any exit                   |
| `/srv/leuven/data/leuven.sqlite` | Accounts, sessions, outfits and last positions (with its `-wal` and `-shm` files). Back this up.        |
| `/srv/leuven/data/server.env`    | `NODE_ENV=production`, `PORT=8787`, `DATABASE_PATH`, `BETTER_AUTH_URL=https://<vm>.exe.xyz`, the secret |
| nginx, port 8000                 | The site; `/api/` and `/ws` proxied to the server on 127.0.0.1:8787                                     |

The server listens on 127.0.0.1 only. nginx passes the client's address as `X-Real-IP`, taken from the last entry of exe.dev's `X-Forwarded-For` (the one a client can't forge), which better-auth rate-limits sign-ins by. `/ws` keeps WebSocket upgrades and an hour of read timeout; the client's heartbeat keeps it far from that.

To look at the server: `ssh leuven.exe.xyz 'sudo journalctl -u leuven-server -n 100'`. To change its environment, edit `server.env` with sudo and `sudo systemctl restart leuven-server`.

## Caching

| Path                                                                                | `Cache-Control`                       | Why                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| `/assets/*`                                                                         | `public, max-age=31536000, immutable` | File names carry a content hash                        |
| `/icons/*`                                                                          | `public, max-age=86400`               | Stable names, rarely change                            |
| `/api/*`                                                                            | `no-store`                            | Per-user answers and session cookies                   |
| everything else (`index.html`, `sw.js`, manifest, `data/city.bin`, `data/walk.bin`) | `no-cache`                            | Revalidated by ETag, so a deploy shows up on next load |

TLS is terminated by exe.dev's proxy; nginx only speaks HTTP on the VM.

## Rolling back

A release holds the site and the server from the same commit, so one symlink rolls back both; restart the server to load its half.

```bash
ssh leuven.exe.xyz 'ls /srv/leuven/releases'
ssh leuven.exe.xyz 'ln -sfn /srv/leuven/releases/<release> /srv/leuven/current.next && mv -Tf /srv/leuven/current.next /srv/leuven/current && sudo systemctl restart leuven-server'
```

Releases from before the server have no `site/` folder and can't be rolled back to with this nginx config.
