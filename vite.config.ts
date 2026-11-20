import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // Relative base so the built app can be served from any path (e.g. a static host
  // or a local HTTPS proxy) without rebuilding.
  base: './',
  server: {
    // Exposed on the LAN so a desktop browser can hit it while developing.
    // NOTE: camera access requires a secure context - see README notes in App.vue.
    host: true,
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
