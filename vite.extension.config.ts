import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'extension',
  base: './',
  plugins: [react()],
  build: { outDir: '../dist/extension', emptyOutDir: true, target: 'chrome116' },
});
