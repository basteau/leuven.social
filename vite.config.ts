import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

// The multiplayer server (server/main.ts, `bun run dev:server`) answers /api and /ws on the
// page's own origin, as nginx makes it in production, so cookies and the socket need no CORS.
// The smoke test runs one of its own on a free port, and says where.
const MULTIPLAYER = process.env.LEUVEN_SERVER ?? 'http://127.0.0.1:8787';
const proxy = {
  '/api': MULTIPLAYER,
  '/ws': { target: MULTIPLAYER, ws: true },
};

/**
 * The engine is a dynamic import, found only once the shell has run: naming it and the palette
 * in the page starts their download with the first bytes of HTML, beside the shell.
 */
function preloadEngine(): Plugin {
  return {
    name: 'preload-engine',
    transformIndexHtml: {
      order: 'post',
      handler(html, { bundle }) {
        return Object.values(bundle ?? {})
          .filter((c) => c.type === 'chunk' && (c.name === 'viewer' || c.name === 'palette'))
          .filter((c) => !html.includes(c.fileName)) // the shell may already bring it
          .map((c) => ({
            tag: 'link',
            attrs: { rel: 'modulepreload', crossorigin: true, href: `/${c.fileName}` },
            injectTo: 'head' as const,
          }));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), preloadEngine()],
  server: { host: true, proxy },
  preview: { proxy },
  // Size limits are enforced by scripts/budget.ts, not by Vite's generic warning.
  build: {
    target: 'es2023',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1024,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // The palette is imported by the engine and by both chunks it loads later (walk mode,
          // the furniture), so the bundler keeps it in a small chunk of its own that loads with
          // the engine. Named, so scripts/budget.ts can count it with the first load.
          groups: [{ name: 'palette', test: /src[\\/]scene[\\/]palette\.ts$/ }],
        },
      },
    },
  },
});
