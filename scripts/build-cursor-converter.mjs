#!/usr/bin/env node
// Bundle the cursor converter (src/lib/cursorImport/host.ts) into
// electron/cursor-converter.js, a classic script that electron/cursorConverter.mts
// runs in the sandboxed window it converts imported cursor themes in.
//
// The output is gitignored and rebuilt by `npm run dev`, `npm run build`,
// `npm test`, and the DinOS Nix build.

import path from 'node:path';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');

await build({
  configFile: false,
  logLevel: 'error',
  root,
  build: {
    outDir: path.join(root, 'electron'),
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'chrome120',
    lib: {
      entry: path.join(root, 'src/lib/cursorImport/host.ts'),
      formats: ['iife'],
      name: 'DinCursorConverter',
      fileName: () => 'cursor-converter.js',
    },
  },
});
