#!/usr/bin/env node
/**
 * Smaller copies of the built-in apps' icons (public/icons/apps/*.png, 512px)
 * at ICON_SIZES in src/shared/iconSizes.ts, as public/icons/apps/<size>/<name>.png,
 * for srcset to pick from (bundledIconProps). A 512px icon is a megabyte
 * decoded, wherever it's drawn, the Dock's 59px and a sidebar's 24px too.
 *
 *   node scripts/icon-sizes.mjs          # make those missing or older than their icon (ImageMagick's `magick`)
 *   node scripts/icon-sizes.mjs --check  # every icon has them (npm test)
 *
 * The copies are committed, so a build needs no ImageMagick (DinOS's Nix
 * build sees only tracked files). Run this after adding or changing an icon.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "public/icons/apps");
const sizes = JSON.parse(/ICON_SIZES = (\[[\d, ]+\])/.exec(readFileSync(join(root, "src/shared/iconSizes.ts"), "utf8"))[1]);
const icons = readdirSync(dir).filter((f) => f.endsWith(".png"));
const check = process.argv.includes("--check");

const stale = [];
for (const icon of icons) {
  for (const size of sizes) {
    const out = join(dir, String(size), icon);
    // A checkout's files all have its own time, in no order: --check only asks that the copies are there.
    if (check) {
      if (!existsSync(out)) stale.push(`${size}/${icon}`);
      continue;
    }
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(join(dir, icon)).mtimeMs) continue;
    mkdirSync(dirname(out), { recursive: true });
    const r = spawnSync("magick", [join(dir, icon), "-filter", "Lanczos", "-resize", `${size}x${size}`, "-strip", out], { stdio: "inherit" });
    if (r.error || r.status !== 0) {
      console.error(`icon-sizes: magick failed on ${icon} (is ImageMagick installed?)`);
      process.exit(1);
    }
  }
}
if (stale.length > 0) {
  console.error(`icon-sizes: missing or older than their icon: ${stale.join(", ")}\nRun: node scripts/icon-sizes.mjs`);
  process.exit(1);
}
if (!check) console.log(`icon-sizes: ${icons.length} icons at ${sizes.join(", ")}px`);
