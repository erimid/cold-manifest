import { defineConfig } from 'vite';

// Relative base so the static build works from any path on any static host.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2020' },
});
