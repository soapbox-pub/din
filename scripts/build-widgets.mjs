#!/usr/bin/env node
// Build the built-in widgets (src/widgets/<id>/, docs/widgets.md) into
// dist/widgets/<id>/index.html. A widget is a napplet, and a napplet is one
// self-contained page (NIP-5D), so each is built on its own with its script
// and styles inlined. Also copies @napplet/shim's prelude, which
// electron/widgets.mts injects into every widget, to dist/widgets/.
//
// Run after `vite build` (which empties dist/), by `npm run build`,
// `npm test`, `npm run dev` and the DinOS Nix build. Rerun it after changing
// a widget: widgets aren't hot-reloaded.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const widgetsDir = path.join(root, 'src/widgets');
const outDir = path.join(root, 'dist/widgets');

/** Inline the page's own script and stylesheet, leaving one file. */
function singleFile() {
  return {
    name: 'din-widget-single-file',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = Object.values(bundle).find((o) => o.type === 'asset' && o.fileName.endsWith('.html'));
      if (!page) throw new Error('build-widgets: no page');
      let html = String(page.source);
      for (const [name, output] of Object.entries(bundle)) {
        if (output === page) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (output.type === 'chunk') {
          const code = output.code.replace(/<\/script/gi, '<\\/script');
          html = html.replace(new RegExp(`<script([^>]*) src="/${escaped}"></script>`), (_tag, attrs) => `<script${attrs}>${code}</script>`);
        } else if (name.endsWith('.css')) {
          const css = String(output.source).replace(/<\/style/gi, '<\\/style');
          html = html.replace(new RegExp(`<link rel="stylesheet"[^>]* href="/${escaped}">`), () => `<style>${css}</style>`);
        } else {
          continue;
        }
        delete bundle[name];
      }
      page.source = html.replace(/ crossorigin/g, '');
    },
  };
}

const ids = fs.existsSync(widgetsDir)
  ? fs.readdirSync(widgetsDir).filter((id) => fs.existsSync(path.join(widgetsDir, id, 'index.html')))
  : [];

for (const id of ids) {
  await build({
    configFile: false,
    logLevel: 'error',
    root: path.join(widgetsDir, id),
    base: '/',
    publicDir: false,
    resolve: { alias: { '@': path.join(root, 'src') } },
    plugins: [singleFile()],
    build: {
      outDir: path.join(outDir, id),
      emptyOutDir: true,
      target: 'chrome120',
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      cssCodeSplit: false,
      modulePreload: false,
      rollupOptions: { output: { codeSplitting: false } },
    },
  });
}

const require = createRequire(import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(require.resolve('@napplet/shim/prelude.global'), path.join(outDir, 'napplet-prelude.js'));
