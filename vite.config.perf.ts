import { mergeConfig } from "vite";

import base from "./vite.config";

/**
 * The build `scripts/perf-profile.mjs` drives, into `dist-perf/` so profiling
 * never clobbers `dist/`. Profiling has to happen against a production build:
 * a dev build's React is several times slower and would put the wrong
 * components at the top of every table. Run with `VITE_PROFILE=1` (the
 * harness does) for the probes, component names and source maps.
 */
export default mergeConfig(base({ command: "build", mode: "production" }), {
  build: {
    outDir: "dist-perf",
    emptyOutDir: true,
    rollupOptions: {
      // Unmangled module scopes: a heap snapshot then names the cache that grew
      // instead of its minified letter (scripts/heap-diff.mjs).
      output: { minify: { compress: true, mangle: false, codegen: true } },
    },
  },
  preview: {
    port: 8383,
    strictPort: true,
  },
});
