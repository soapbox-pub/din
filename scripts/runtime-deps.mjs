/**
 * package.json's `dependencies` are what Electron main loads at runtime;
 * everything Vite bundles is a devDependency. DinOS ships just those (its
 * build prunes the rest), and so do the login session's builds.
 *
 * Prints the node_modules directories `dependencies` need: the packages and
 * theirs (optional ones where installed), one per line, relative to the repo,
 * for scripts/session.mjs. Directories nested in another's node_modules are
 * left out, since copying the outer one brings them.
 *
 * --check (in `npm test`) fails unless `dependencies` are exactly the
 * packages electron/ imports: a runtime package left out is missing from
 * DinOS, and Din doesn't start; a bundled one put in ships for nothing.
 *
 *   node scripts/runtime-deps.mjs
 *   node scripts/runtime-deps.mjs --check
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** The packages electron/'s modules and preloads import, by name. */
function electronImports() {
  const dir = join(root, "electron");
  const names = new Set();
  const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire(?:\.resolve)?\s*\(\s*)["']([^"'./][^"']*)["']/g;
  const pkg = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*/;
  for (const file of readdirSync(dir).filter((f) => /\.(mts|cjs)$/.test(f))) {
    for (const [, spec] of readFileSync(join(dir, file), "utf8").matchAll(specifier)) {
      if (spec.startsWith("node:")) continue;
      const name = pkg.exec(spec)?.[0];
      if (!name || name === "electron" || (spec !== name && spec[name.length] !== "/")) continue;
      names.add(name);
    }
  }
  return [...names];
}

const runtime = Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies ?? {});

if (process.argv[2] === "--check") {
  const imports = electronImports();
  const missing = imports.filter((name) => !runtime.includes(name));
  const unused = runtime.filter((name) => !imports.includes(name));
  for (const name of missing) console.error(`runtime-deps: electron/ imports ${name}, so it belongs in package.json's dependencies`);
  for (const name of unused) console.error(`runtime-deps: electron/ doesn't import ${name}, so it belongs in package.json's devDependencies`);
  process.exit(missing.length || unused.length ? 1 : 0);
}

for (const name of runtime) walk(name, root, false);

const dirs = [...found].map((d) => relative(root, d)).sort();
for (const dir of dirs) {
  if (dirs.some((other) => other !== dir && dir.startsWith(`${other}/`))) continue;
  console.log(dir);
}
