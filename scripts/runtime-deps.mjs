/**
 * Prints the node_modules directories some packages need at runtime: the
 * packages and their dependencies (optional ones where installed), one per
 * line, relative to the repo. Directories nested in another's
 * node_modules are left out, since copying the outer one brings them.
 * For os/configuration.nix, which copies Electron main's runtime modules
 * beside it.
 *
 *   node scripts/runtime-deps.mjs imapflow nodemailer mailparser
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const found = new Set();

/** Where Node would find `name` from inside `from`. */
function locate(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root || dirname(dir) === dir) return null;
  }
}

function walk(name, from, optional) {
  const dir = locate(name, from);
  if (!dir) {
    if (optional) return;
    console.error(`runtime-deps: ${name} isn't installed`);
    process.exit(1);
  }
  if (found.has(dir)) return;
  found.add(dir);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, dir, false);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) walk(dep, dir, true);
}

for (const name of process.argv.slice(2)) walk(name, root, false);

const dirs = [...found].map((d) => relative(root, d)).sort();
for (const dir of dirs) {
  if (dirs.some((other) => other !== dir && dir.startsWith(`${other}/`))) continue;
  console.log(dir);
}
