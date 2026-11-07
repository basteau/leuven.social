/**
 * Builds the app and the multiplayer server and publishes both to a public exe.dev VM: nginx
 * serves the site and proxies /api and /ws to the server, a systemd service under its own user;
 * exe.dev's proxy adds HTTPS. Safe to rerun: it creates the VM, installs Bun and configures the
 * services only when needed, uploads each build as a new release and switches to it atomically.
 * See docs/DEPLOY.md.
 *
 *   bun run deploy            # VM "leuven" → https://leuven.exe.xyz/
 *   bun run deploy my-vm      # another VM
 */

const VM = Bun.argv[2] ?? 'leuven';
const HOST = `${VM}.exe.xyz`;
const SITE = `https://${HOST}/`;
/** exe.dev proxies HTTPS to this VM port. */
const PORT = 8000;
/** The multiplayer server, reachable only through nginx. */
const SERVER_PORT = 8787;
const ROOT = '/srv/leuven';
/** The database and the server's environment: outside the releases, never replaced. */
const DATA = `${ROOT}/data`;
const SERVICE = 'leuven-server';
const SERVICE_USER = 'leuven';
const BUN_DIR = '/opt/bun';
/** The same Bun as the repo (package.json's packageManager), so the server runs as tested. */
const BUN_VERSION = (
  (await Bun.file(new URL('../package.json', import.meta.url)).json()) as { packageManager: string }
).packageManager.replace(/^bun@/, '');
const KEEP_RELEASES = 3;
const REPO = Bun.fileURLToPath(new URL('../', import.meta.url));
const SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];

// Hashed /assets/ never change, so browsers keep them for a year. Everything else (index.html,
// sw.js, the manifest, data/city.bin) revalidates on every load against nginx's ETag, so a new
// deploy shows up at once. add_header only fires on 2xx/3xx, so a 404 is never cached as immutable.
// exe.dev's proxy appends the client's address to X-Forwarded-For, so its last entry is the one
// a client can't forge: that becomes X-Real-IP, which the server rate-limits sign-ins by.
const NGINX_SITE = `map $http_x_forwarded_for $leuven_client_ip {
    "~(?<last>[^,\\s]+)\\s*$" $last;
    default $remote_addr;
}

server {
    listen ${PORT} default_server;
    listen [::]:${PORT} default_server;
    root ${ROOT}/current/site;
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
    location /api/ {
        proxy_pass http://127.0.0.1:${SERVER_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $leuven_client_ip;
        proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
        proxy_read_timeout 30s;
        client_max_body_size 16k;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store" always;
    }
    location = /ws {
        proxy_pass http://127.0.0.1:${SERVER_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $leuven_client_ip;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
    location / {
        try_files $uri $uri/ =404;
    }
}
`;

// Restarts on any exit, as its own unprivileged user, able to write only its data directory.
const SYSTEMD_UNIT = `[Unit]
Description=leuven.social multiplayer server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
EnvironmentFile=${DATA}/server.env
Environment=BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
WorkingDirectory=${DATA}
ExecStart=${BUN_DIR}/bin/bun ${ROOT}/current/server/main.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA}

[Install]
WantedBy=multi-user.target
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
  await lobby('new', `--name=${VM}`, "--comment='leuven.social'", '--json');
}

async function ensureBun(): Promise<void> {
  // Bun's own installer, into a system-wide directory the service user can run from.
  await onVm(
    `set -e
     if [ "$(${BUN_DIR}/bin/bun --version 2>/dev/null)" != "${BUN_VERSION}" ]; then
       command -v unzip >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq unzip; }
       curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=${BUN_DIR} bash -s "bun-v${BUN_VERSION}" >/dev/null
       sudo chmod -R a+rX ${BUN_DIR}
     fi
     test "$(${BUN_DIR}/bin/bun --version)" = "${BUN_VERSION}"`,
  );
}

async function upload(): Promise<string> {
  const sha = await run(['git', 'rev-parse', '--short', 'HEAD']);
  const dirty = (await run(['git', 'status', '--porcelain'])) ? '-dirty' : '';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const release = `${stamp}-${sha}${dirty}`;
  // One release holds the site and the server built from the same commit, so a rollback
  // can't pair a page with a server that speaks another protocol.
  const tar = Bun.spawn(['tar', '-C', REPO, '-czf', '-', 'dist', 'dist-server/main.js'], {
    stdout: 'pipe',
  });
  // Unpack beside the live build, then swap the symlink in one rename: no half-deployed state.
  await onVm(
    `set -e
     sudo install -d -o "$USER" ${ROOT} ${ROOT}/releases
     dir=${ROOT}/releases/${release}
     mkdir -p "$dir" && tar -xzf - -C "$dir"
     mv "$dir/dist" "$dir/site" && mv "$dir/dist-server" "$dir/server"
     test -f "$dir/site/index.html" && test -f "$dir/server/main.js"
     ln -sfn "$dir" ${ROOT}/current.next && mv -Tf ${ROOT}/current.next ${ROOT}/current
     ls -1d ${ROOT}/releases/*/ | head -n -${KEEP_RELEASES} | xargs -r rm -rf`,
    tar.stdout,
  );
  if ((await tar.exited) !== 0) throw new Error('tar of dist/ and dist-server/ failed');
  return release;
}

async function configureServer(): Promise<void> {
  // The env file is written once, with a fresh secret: rewriting it would sign everyone out.
  await onVm(
    `set -e
     id -u ${SERVICE_USER} >/dev/null 2>&1 ||
       sudo useradd --system --home-dir ${DATA} --shell /usr/sbin/nologin ${SERVICE_USER}
     sudo install -d -o ${SERVICE_USER} -g ${SERVICE_USER} -m 750 ${DATA}
     if ! sudo test -f ${DATA}/server.env; then
       secret=$(openssl rand -hex 32)
       printf '%s\\n' NODE_ENV=production PORT=${SERVER_PORT} DATABASE_PATH=${DATA}/leuven.sqlite \\
         BETTER_AUTH_URL=https://${HOST} "BETTER_AUTH_SECRET=$secret" |
         sudo sh -c 'umask 077 && cat > ${DATA}/server.env'
     fi
     new=$(mktemp); cat > "$new"
     if ! cmp -s "$new" /etc/systemd/system/${SERVICE}.service; then
       sudo install -m 644 "$new" /etc/systemd/system/${SERVICE}.service
       sudo systemctl daemon-reload
       sudo systemctl enable -q ${SERVICE}
     fi
     rm -f "$new"
     sudo systemctl restart ${SERVICE}
     for i in $(seq 1 30); do
       curl -fsS http://127.0.0.1:${SERVER_PORT}/api/health >/dev/null 2>&1 && exit 0
       sleep 0.5
     done
     sudo journalctl -u ${SERVICE} -n 30 --no-pager >&2
     exit 1`,
    new Blob([SYSTEMD_UNIT]),
  );
}

async function configureNginx(): Promise<void> {
  // Rewrites the site file and reloads only when it changed, so reruns cost one round trip.
  await onVm(
    `set -e
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

async function expectHeaders(path: string, cacheControl: string): Promise<Response> {
  const response = await fetch(new URL(path, SITE), { redirect: 'manual' });
  const got = response.headers.get('cache-control');
  if (!response.ok || got !== cacheControl) {
    throw new Error(`${path}: ${response.status}, Cache-Control "${got}" (want "${cacheControl}")`);
  }
  return response;
}

async function checkLive(): Promise<void> {
  const html = await (await fetch(SITE)).text();
  const asset = /\/assets\/[^"]+\.js/.exec(html)?.[0];
  if (!asset) throw new Error(`${SITE} does not look like the app (no /assets/*.js in index.html)`);
  await expectHeaders('/', 'no-cache');
  await expectHeaders('/sw.js', 'no-cache');
  await expectHeaders('/data/city.bin', 'no-cache');
  await expectHeaders(asset, 'public, max-age=31536000, immutable');
  const health = (await (await expectHeaders('/api/health', 'no-store')).json()) as {
    ok?: boolean;
  };
  if (health.ok !== true) throw new Error(`/api/health: ${JSON.stringify(health)}`);
}

try {
  step('building');
  await run(['bun', 'run', 'build']);
  await run(['bun', 'run', 'build:server']);
  await ensureVm();
  step(`installing Bun ${BUN_VERSION} on ${HOST} if needed`);
  await ensureBun();
  step('uploading dist/ and dist-server/');
  const release = await upload();
  step(`restarting ${SERVICE}`);
  await configureServer();
  step(`configuring nginx on ${HOST}`);
  await configureNginx();
  step('making it public');
  await lobby('share', 'port', VM, String(PORT));
  await lobby('share', 'set-public', VM);
  await checkLive();
  console.log(`\nok  release ${release} is live at ${SITE}`);
} catch (error) {
  console.error(`\nDEPLOY FAILED  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
