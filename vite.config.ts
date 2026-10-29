import fs from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

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

/**
 * Built-in apps (docs/din/README.md): every src/apps/<id>/index.html is a
 * page of the build, served at din://<id>/ by electron/din-apps.mts. In
 * development their pages come from this server, through din:// in Electron
 * and from <id>.localhost here in a plain browser, so the HMR client is
 * pointed at localhost, and their CSP (and the desktop's, for framing them
 * outside Electron) lets it through. Each app page's first script is
 * src/sdk/frame.ts, window.din where no preload provides it.
 */
function dinApps(): Plugin {
  const appsDir = path.resolve(__dirname, "src/apps");
  const pages = fs.existsSync(appsDir)
    ? fs.readdirSync(appsDir).filter((id) => fs.existsSync(path.join(appsDir, id, "index.html")))
    : [];
  return {
    name: "din-apps",
    config: () => ({
      build: {
        rollupOptions: {
          input: {
            main: path.resolve(__dirname, "index.html"),
            ...Object.fromEntries(pages.map((id) => [`app-${id}`, path.join(appsDir, id, "index.html")])),
          },
        },
      },
    }),
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const app = ctx.path.startsWith("/src/apps/");
        // window.din where no preload provides it (src/sdk/frame.ts), ahead of the app's own scripts.
        const tags = app
          ? [{ tag: "script", attrs: { type: "module", src: "/src/sdk/frame.ts" }, injectTo: "head-prepend" as const }]
          : [];
        if (!ctx.server) return { html, tags };
        if (app) return { html: html.replace("connect-src ", "connect-src ws://localhost:* "), tags };
        return html.replace("frame-src ", "frame-src http://*.localhost:* ");
      },
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
    // Apps' pages are din:// (or <id>.localhost) documents: their HMR
    // client must still find this server.
    hmr: { host: "localhost", protocol: "ws" },
  },
  plugins: [
    react(),
    tailwindcss(),
    dinApps(),
  ],
  // The Calculator's giac worker imports its WebAssembly relative to
  // itself, which pre-bundling would break.
  optimizeDeps: {
    exclude: ["@basthon/xcas-wasm"],
  },
  worker: {
    format: "es" as const,
  },
  build: {
    sourcemap: PROFILE_BUILD,
    // The shell's CSP has no data: in font-src, so small fonts (KaTeX's)
    // stay files instead of being inlined.
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
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
