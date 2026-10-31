/**
 * Builds the app and publishes dist/ to a public exe.dev VM, served by nginx on the VM and
 * HTTPS from exe.dev's proxy. Safe to rerun: it creates the VM and configures nginx only when
 * needed, uploads each build as a new release and switches to it atomically. See docs/DEPLOY.md.
 *
 *   bun run deploy            # VM "leuven" → https://leuven.exe.xyz/
 *   bun run deploy my-vm      # another VM
 */

const VM = Bun.argv[2] ?? 'leuven';
const HOST = `${VM}.exe.xyz`;
const SITE = `https://${HOST}/`;
/** exe.dev proxies HTTPS to this VM port. */
const PORT = 8000;
const ROOT = '/srv/leuven';
const KEEP_RELEASES = 3;
const DIST = Bun.fileURLToPath(new URL('../dist/', import.meta.url));
const SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];

// Hashed /assets/ never change, so browsers keep them for a year. Everything else (index.html,
// sw.js, the manifest, data/city.bin) revalidates on every load against nginx's ETag, so a new
// deploy shows up at once. add_header only fires on 2xx/3xx, so a 404 is never cached as immutable.
const NGINX_SITE = `server {
    listen ${PORT} default_server;
    listen [::]:${PORT} default_server;
    root ${ROOT}/current;
    index index.html;
    server_tokens off;

    gzip on;
    gzip_types text/css application/javascript application/json application/manifest+json image/svg+xml;

    add_header Cache-Control "no-cache";

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
    location /icons/ {
        add_header Cache-Control "public, max-age=86400";
    }
    location = /manifest.webmanifest {
        default_type application/manifest+json;
        add_header Cache-Control "no-cache";
    }
    location / {
        try_files $uri $uri/ =404;
    }
}
`;

async function run(cmd: string[], stdin?: Bun.SpawnOptions.Writable): Promise<string> {
  const proc = Bun.spawn(cmd, { stdin: stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed (${code}):\n${err || out}`);
  return out.trim();
}

/** The exe.dev lobby: VM lifecycle and sharing. It takes one command line, not a shell. */
const lobby = (...args: string[]) => run([...SSH, 'exe.dev', ...args]);
/** A shell on the VM itself. */
const onVm = (script: string, stdin?: Bun.SpawnOptions.Writable) =>
  run([...SSH, HOST, script], stdin);

function step(message: string): void {
  console.log(`→ ${message}`);
}

async function ensureVm(): Promise<void> {
  const { vms } = JSON.parse(await lobby('ls', '--json')) as { vms: { vm_name: string }[] };
  if (vms.some((vm) => vm.vm_name === VM)) return;
  step(`creating VM ${VM}`);
  await lobby('new', `--name=${VM}`, "--comment='leuven.social (public static site)'", '--json');
}

async function configureNginx(): Promise<void> {
  // Rewrites the site file and reloads only when it changed, so reruns cost one round trip.
  await onVm(
    `set -e
     sudo install -d -o "$USER" ${ROOT} ${ROOT}/releases
     new=$(mktemp); cat > "$new"
     if ! cmp -s "$new" /etc/nginx/sites-available/leuven; then
       sudo install -m 644 "$new" /etc/nginx/sites-available/leuven
       sudo ln -sfn /etc/nginx/sites-available/leuven /etc/nginx/sites-enabled/leuven
       sudo rm -f /etc/nginx/sites-enabled/default
       sudo nginx -t -q
       sudo systemctl enable -q nginx
       sudo systemctl reload-or-restart nginx
     fi
     rm -f "$new"
     sudo systemctl is-active -q nginx || sudo systemctl start nginx`,
    new Blob([NGINX_SITE]),
  );
}

async function upload(): Promise<string> {
  const sha = await run(['git', 'rev-parse', '--short', 'HEAD']);
  const dirty = (await run(['git', 'status', '--porcelain'])) ? '-dirty' : '';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const release = `${stamp}-${sha}${dirty}`;
  const tar = Bun.spawn(['tar', '-C', DIST, '-czf', '-', '.'], { stdout: 'pipe' });
  // Unpack beside the live build, then swap the symlink in one rename: no half-deployed state.
  await onVm(
    `set -e
     dir=${ROOT}/releases/${release}
     mkdir -p "$dir" && tar -xzf - -C "$dir"
     ln -sfn "$dir" ${ROOT}/current.next && mv -Tf ${ROOT}/current.next ${ROOT}/current
     ls -1d ${ROOT}/releases/*/ | head -n -${KEEP_RELEASES} | xargs -r rm -rf`,
    tar.stdout,
  );
  if ((await tar.exited) !== 0) throw new Error('tar of dist/ failed');
  return release;
}

async function expectHeaders(path: string, cacheControl: string): Promise<void> {
  const response = await fetch(new URL(path, SITE), { redirect: 'manual' });
  const got = response.headers.get('cache-control');
  if (!response.ok || got !== cacheControl) {
    throw new Error(`${path}: ${response.status}, Cache-Control "${got}" (want "${cacheControl}")`);
  }
}

async function checkLive(): Promise<void> {
  const html = await (await fetch(SITE)).text();
  const asset = /\/assets\/[^"]+\.js/.exec(html)?.[0];
  if (!asset) throw new Error(`${SITE} does not look like the app (no /assets/*.js in index.html)`);
  await expectHeaders('/', 'no-cache');
  await expectHeaders('/sw.js', 'no-cache');
  await expectHeaders('/data/city.bin', 'no-cache');
  await expectHeaders(asset, 'public, max-age=31536000, immutable');
}

try {
  step('building');
  await run(['bun', 'run', 'build']);
  await ensureVm();
  step(`configuring nginx on ${HOST}`);
  await configureNginx();
  step('uploading dist/');
  const release = await upload();
  step('making it public');
  await lobby('share', 'port', VM, String(PORT));
  await lobby('share', 'set-public', VM);
  await checkLive();
  console.log(`\nok  release ${release} is live at ${SITE}`);
} catch (error) {
  console.error(`\nDEPLOY FAILED  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
