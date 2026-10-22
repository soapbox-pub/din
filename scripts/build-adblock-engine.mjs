#!/usr/bin/env node
// Bundle Ghostery's filter engine into electron/adblock-extension/engine.js,
// a classic script that defines a global `DinAdblockEngine` for the built-in
// ad blocker's background page (see electron/adblock.mts for the design).
//
// Extension pages can't resolve npm packages, and the engine's dependencies
// ship no browser bundles of their own, so this is the one piece of the
// Electron host that needs a build step. The output is gitignored and
// rebuilt by `npm run dev`, `npm run build`, and the DinOS Nix build.

import path from 'node:path';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');

await build({
  configFile: false,
  logLevel: 'error',
  root,
  build: {
    outDir: path.join(root, 'electron/adblock-extension'),
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'chrome120',
    lib: {
      entry: path.join(root, 'scripts/adblock-engine-entry.js'),
      formats: ['iife'],
      name: 'DinAdblockEngine',
      fileName: () => 'engine.js',
    },
  },
});
