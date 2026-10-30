/**
 * Compiles the Electron host (electron/*.mts) to plain JavaScript beside it
 * (electron/*.mjs), which is what production runs: DinOS, and the login
 * session's builds (scripts/session.mjs).
 *
 * Development runs the .mts files directly through Node's type stripping, so
 * `npm run dev` needs no build. A build shouldn't pay for that: Node's
 * TypeScript stripper is ~12 MB of WebAssembly, loaded into every process
 * that runs a .mts file - the main process and the services host alike.
 *
 * Stripping only (no type check; `tsc -p tsconfig.electron.json` does that),
 * with relative `.mts` imports rewritten to `.mjs`. Files that name a sibling
 * at runtime take the extension they run as (path.extname(import.meta.filename)).
 *
 *   node scripts/build-electron.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "electron");

let count = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".mts"))) {
  const source = readFileSync(join(dir, file), "utf8");
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      verbatimModuleSyntax: true,
      rewriteRelativeImportExtensions: true,
    },
  });
  if (diagnostics?.length) {
    for (const d of diagnostics) console.error(`${file}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    process.exit(1);
  }
  writeFileSync(join(dir, file.replace(/\.mts$/, ".mjs")), outputText);
  count++;
}
console.log(`electron: compiled ${count} modules`);
