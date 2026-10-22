import path from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

/**
 * `npm run build:profile`: a production build that can be profiled. Two
 * differences, each of which a profile of the normal build is missing:
 *  - names kept, so every frame of a CPU profile and every component in the
 *    render report reads as its name instead of `Xe`;
 *  - source maps, so a Performance-panel flame graph maps back to `src/`.
 *
 * Also stamps `VITE_PROFILE=1`, which installs the runtime probes
 * (`src/lib/perfRuntime.ts`). Never a release build — it is larger and a
 * little slower.
 *
 * `VITE_PROFILE_REACT=1` on top swaps in react-dom's PROFILING build, so every
 * fiber carries its render time and the report gives self time per component.
 * Opt-in, because React 19.2's profiling build also logs every component
 * render to the Performance timeline, which inflates the CPU a flow measures.
 */
const PROFILE_BUILD = process.env.VITE_PROFILE === "1";
const PROFILE_REACT = PROFILE_BUILD && process.env.VITE_PROFILE_REACT === "1";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    sourcemap: PROFILE_BUILD,
    rollupOptions: {
      output: PROFILE_BUILD ? { keepNames: true } : {},
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/{vite,eslint}.config.*',
      '.agents/**',
    ],
    onConsoleLog(log) {
      return !log.includes("React Router Future Flag Warning");
    },
    env: {
      DEBUG_PRINT_LIMIT: '0', // Suppress DOM output that exceeds AI context windows
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      // react-dom/profiling is react-dom/client plus fiber timings.
      ...(PROFILE_REACT ? [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] : []),
    ],
  },
}));
