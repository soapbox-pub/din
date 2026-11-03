// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y-x";
import tseslint from "typescript-eslint";
import htmlEslint from "@html-eslint/eslint-plugin";
import customRules from "./eslint-rules/index.js";

export default defineConfig(
  globalIgnores(["dist", "dist-perf", "perf-reports", ".agents", "electron/adblock-extension/engine.js", "electron/cursor-converter.js", "electron/din-app-preload.built.cjs", "electron/power-mode-preload.built.cjs", "electron/*.mjs"]),
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
      "custom/no-guest-engine": "error",
      // Electron IPC is the preloads' (electron/); the desktop uses
      // window.dinos and apps window.din (AGENTS.md, docs/README.md).
      "no-restricted-imports": ["error", {
        paths: [{ name: "electron", message: "Electron IPC belongs to the preloads: use window.dinos (desktop) or window.din (apps)." }],
      }],
    },
  },
  {
    // Accessibility: roles, names, ARIA and labels. The rules about mouse
    // handlers on plain elements are off: a desktop hands keyboard handling
    // to the container (a toolbar's arrow keys, a list's selection), and
    // clicking a backdrop away has Escape beside it. Fields focus themselves
    // as native apps' do, and the user's own videos have no captions.
    name: "app/a11y",
    files: ["src/**/*.tsx"],
    extends: [jsxA11y.configs.recommended],
    rules: {
      "jsx-a11y-x/no-autofocus": "off",
      "jsx-a11y-x/media-has-caption": "off",
      "jsx-a11y-x/click-events-have-key-events": "off",
      "jsx-a11y-x/no-static-element-interactions": "off",
      "jsx-a11y-x/no-noninteractive-element-interactions": "off",
      "jsx-a11y-x/interactive-supports-focus": "off",
      // A splitter (a focusable separator) takes the arrow keys, and a Linux
      // app's window (role application) all of them.
      "jsx-a11y-x/no-noninteractive-tabindex": ["error", { tags: [], roles: ["tabpanel", "separator", "application"] }],
      "jsx-a11y-x/label-has-associated-control": ["error", {
        controlComponents: ["Input", "Switch", "Checkbox", "Slider", "Textarea", "SelectTrigger", "RadioGroupItem"],
        depth: 3,
      }],
    },
  },
  {
    // Built-in apps and the code they share run in their own documents and
    // reach the desktop only through window.din (docs/din/README.md).
    name: "app/apps",
    files: ["src/apps/**/*.{ts,tsx}", "src/shared/**/*.{ts,tsx}", "src/sdk/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "electron", message: "Electron IPC belongs to the preloads: apps use window.din." }],
        patterns: [
          { group: ["@/components/desktop/*"], message: "Apps run in their own document: use window.din (@/sdk), or move shared code to src/shared/." },
          { group: ["@/contexts/Window*", "@/contexts/FilePickerContext", "@/contexts/MonitorsContext", "@/hooks/useWindows", "@/lib/apps", "@/lib/dinApps", "@/lib/closeGuards", "@/lib/menuBarSlot", "@/lib/portalContainer", "@/platform/*"], message: "That's the desktop's; apps use window.din (@/sdk)." },
        ],
      }],
      "no-restricted-syntax": ["error", {
        selector: "MemberExpression[object.name='window'][property.name='dinos']",
        message: "window.dinos is the desktop's alone; apps use window.din (din.system for granted bridges).",
      }],
    },
  },
  {
    // Built-in widgets are napplets: their own documents, reaching the
    // desktop only through window.napplet (docs/widgets.md).
    name: "app/widgets",
    files: ["src/widgets/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "electron", message: "Widgets reach the desktop only through window.napplet." }],
        patterns: [
          { group: ["@/*", "!@/widgets/*"], message: "Widgets are self-contained napplets: use window.napplet, and only code in src/widgets/." },
        ],
      }],
      "no-restricted-syntax": ["error", {
        selector: "MemberExpression[object.name='window'][property.name=/^(dinos|din|nostr)$/]",
        message: "Widgets get window.napplet and nothing else.",
      }],
    },
  },
  {
    // The one place that knows the guest engine (docs/guest-surfaces.md).
    name: "app/platform",
    files: ["src/platform/**/*.{ts,tsx}"],
    rules: {
      "custom/no-guest-engine": "off",
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
    files: ["electron/browser-highlight-preload.cjs", "electron/notification-preload.cjs", "electron/geolocation-preload.cjs", "electron/permissions-preload.cjs", "electron/chrome-app-preload.cjs", "electron/nostr-preload.cjs", "electron/adblock-preload.cjs", "electron/adblock-scriptlets-preload.cjs", "electron/popup-preload.cjs", "electron/print-preload.cjs", "electron/screen-share-preload.cjs", "electron/eyedropper-preload.cjs", "electron/media-preload.cjs", "electron/passwords-preload.cjs", "electron/power-mode-preload.cjs", "electron/napp-preload.cjs", "electron/web-push-preload.cjs", "electron/din-app-preload.cjs", "electron/din-app-worker-preload.cjs", "electron/widget-preload.cjs", "electron/preload.cjs"],
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
  {
    // A widget is one page with nothing to link: no web manifest or Open Graph.
    name: "app/widgets-html",
    files: ["src/widgets/**/*.html"],
    rules: {
      "@html-eslint/require-open-graph-protocol": "off",
      "custom/require-webmanifest": "off",
    },
  },
);
