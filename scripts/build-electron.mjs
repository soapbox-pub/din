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
 * V8 keeps every module's source for as long as it's loaded, and the main
 * process loads them all: at two bytes a character once a module has a single
 * character outside Latin-1 (a curly quote in a message, an arrow in a
 * comment), which over half of them do. So comments go, and what's left of
 * those characters in strings and regular expressions is written as \u
 * escapes: 4.5 MB of source in main's heap comes to 2.
 *
 *   node scripts/build-electron.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "electron");

const NON_ASCII = /[^\x00-\x7f]/;

/**
 * The module with every character outside ASCII in a string, a template or a
 * regular expression as its \u escape, which means the same there. Not in a
 * tagged template, whose tag can see how it was written, nor after a
 * backslash, which an escape would be read differently behind.
 */
function escapeToAscii(file, code) {
  if (!NON_ASCII.test(code)) return code;
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.ES2023, true);
  const spans = [];
  const visit = (node) => {
    const literal =
      ts.isStringLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && !ts.isTaggedTemplateExpression(node.parent));
    if (literal && !ts.isTemplateExpression(node)) spans.push([node.getStart(source), node.getEnd()]);
    if (ts.isTemplateExpression(node) && literal) {
      spans.push([node.head.getStart(source), node.head.getEnd()]);
      for (const span of node.templateSpans) spans.push([span.literal.getStart(source), span.literal.getEnd()]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let out = "";
  let at = 0;
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    out += code.slice(at, start);
    for (let i = start; i < end; i++) {
      const unit = code.charCodeAt(i);
      let slashes = 0;
      while (code[i - 1 - slashes] === "\\") slashes++;
      out += unit > 0x7f && slashes % 2 === 0 ? `\\u${unit.toString(16).padStart(4, "0")}` : code[i];
    }
    at = end;
  }
  return out + code.slice(at);
}

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
      removeComments: true,
    },
  });
  if (diagnostics?.length) {
    for (const d of diagnostics) console.error(`${file}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    process.exit(1);
  }
  writeFileSync(join(dir, file.replace(/\.mts$/, ".mjs")), escapeToAscii(file, outputText));
  count++;
}
console.log(`electron: compiled ${count} modules`);
