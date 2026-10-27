// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import htmlEslint from "@html-eslint/eslint-plugin";
import customRules from "./eslint-rules/index.js";

export default defineConfig(
  globalIgnores(["dist", "dist-perf", "perf-reports", ".agents", "electron/adblock-extension/engine.js", "electron/*.mjs"]),
  {
    name: "app/ts",
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    plugins: {
      custom: customRules,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "custom/no-placeholder-comments": "error",
      "no-warning-comments": ["error", { terms: ["fixme"] }],
    },
  },
  {
    // The Electron host: .mts main-process files (type-stripped by Node in
    // development, compiled to .mjs for production) and the .cjs preloads (JSDoc-typed; sandboxed preloads
    // can't be ESM or TypeScript, so require() stays).
    name: "app/electron",
    files: ["electron/**/*.{mts,cjs}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    plugins: {
      custom: customRules,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // The .cjs preloads are CommonJS by necessity.
      "@typescript-eslint/no-require-imports": "off",
      "custom/no-placeholder-comments": "error",
      "no-warning-comments": ["error", { terms: ["fixme"] }],
    },
  },
  {
    // The guest preloads run in the guest renderer and drive the page DOM
    // directly (window/document/Element/requestAnimationFrame), so they need
    // browser globals on top of the electron block's node globals.
    name: "app/electron-dom-preload",
    files: ["electron/browser-highlight-preload.cjs", "electron/notification-preload.cjs", "electron/geolocation-preload.cjs", "electron/nostr-preload.cjs", "electron/adblock-preload.cjs", "electron/adblock-scriptlets-preload.cjs", "electron/popup-preload.cjs", "electron/print-preload.cjs", "electron/screen-share-preload.cjs", "electron/media-preload.cjs", "electron/napp-preload.cjs"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    name: "app/html",
    files: ["**/*.html"],
    extends: [htmlEslint.configs["flat/recommended"]],
    plugins: {
      custom: customRules,
    },
    rules: {
      "@html-eslint/require-meta-description": "error",
      "@html-eslint/require-meta-viewport": "error",
      "@html-eslint/require-open-graph-protocol": [
        "error",
        ["og:type", "og:title", "og:description"],
      ],
      // The manifest link below intentionally uses `rel="manifest"`; the
      // baseline data currently flags this attribute value as not widely
      // available, which is a false positive for our use case.
      "@html-eslint/use-baseline": "off",
      "custom/no-inline-script": "error",
      "custom/require-webmanifest": "error",
    },
  },
);
