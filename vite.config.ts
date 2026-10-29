import { defineConfig } from 'vite';

// Served from https://<user>.github.io/travel_slicer_web/ on GitHub Pages.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/travel_slicer_web/' : '/',
});
