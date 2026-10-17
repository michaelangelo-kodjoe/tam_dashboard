/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build output goes to ../web (served by the backend, D-13 SPA fallback).
export default defineConfig({
  plugins: [react()],
  base: '/',
  // With VITE_DATA_SOURCE=api (Phase 4.1 release build) public/ is not copied, so mock_data.json never ships.
  build: { outDir: '../web', emptyOutDir: true, sourcemap: false, copyPublicDir: process.env.VITE_DATA_SOURCE !== 'api' },
  server: { port: 5173, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8766' } },
  preview: { host: '127.0.0.1', port: 4173 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    testTimeout: 20000,
  },
});
