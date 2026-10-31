# Deploy

The app is a static build, published to an [exe.dev](https://exe.dev) VM at **https://leuven.exe.xyz/**.

```bash
bun run deploy            # build, upload, go live on the VM "leuven"
bun run deploy my-vm      # the same, to https://my-vm.exe.xyz/
```

It needs an SSH key that is registered with exe.dev (`ssh exe.dev ls` works). The `using-exe-dev` skill in `.agents/skills/` covers signup and the exe.dev CLI.

## What `scripts/deploy.ts` does

Each step is safe to repeat, so a rerun is also how you repair a VM.

1. Runs `bun run build`.
2. Creates the VM with `ssh exe.dev new` if it doesn't exist yet.
3. Writes the nginx site (preinstalled on exe.dev's default image) and reloads nginx only if the config changed. nginx is enabled as a systemd service, so it comes back after a reboot.
4. Streams `dist/` over SSH into `/srv/leuven/releases/<time>-<commit>/`, then points the `/srv/leuven/current` symlink at it in one rename. The last three releases are kept.
5. Points exe.dev's HTTPS proxy at port 8000 and makes it public (`ssh exe.dev share port|set-public`).
6. Fetches the live site and fails if the cache headers below are wrong.

## Caching

| Path                                                               | `Cache-Control`                       | Why                                                    |
| ------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------ |
| `/assets/*`                                                        | `public, max-age=31536000, immutable` | File names carry a content hash                        |
| `/icons/*`                                                         | `public, max-age=86400`               | Stable names, rarely change                            |
| everything else (`index.html`, `sw.js`, manifest, `data/city.bin`) | `no-cache`                            | Revalidated by ETag, so a deploy shows up on next load |

TLS is terminated by exe.dev's proxy; nginx only speaks HTTP on the VM.

## Rolling back

```bash
ssh leuven.exe.xyz 'ls /srv/leuven/releases'
ssh leuven.exe.xyz 'ln -sfn /srv/leuven/releases/<release> /srv/leuven/current.next && mv -Tf /srv/leuven/current.next /srv/leuven/current'
```
