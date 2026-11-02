import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { host: true },
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
