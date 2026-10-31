import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { host: true },
  // Size limits are enforced by scripts/budget.ts, not by Vite's generic warning.
  build: { target: 'es2023', assetsInlineLimit: 0, chunkSizeWarningLimit: 1024 },
});
