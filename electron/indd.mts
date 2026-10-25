// InDesign documents, for Publisher: indd.wasm (indd-utils, built by
// scripts/build-indd-wasm.sh) turns an INDD file into the IDML package the
// app edits. It runs here rather than in the page because the shell's CSP
// has no 'wasm-unsafe-eval', and shouldn't get one for this.
//
// The module needs nothing from its host (no imports), so it can't touch
// the file system or anything else: bytes in, bytes out.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';

interface InddExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  convert(input: number, len: number, name: number, nameLen: number): number;
  output(): number;
}

interface Conversion {
  idml: Uint8Array;
  previews: { graphics: string[]; data: Uint8Array }[];
  warnings: string[];
}

/** Over this, an INDD isn't read (the files bridge reads up to 1 GB). */
const MAX_BYTES = 1024 * 1024 * 1024;

let compiled: WebAssembly.Module | null = null;

function convert(bytes: Uint8Array, name: string): Conversion {
  compiled ??= new WebAssembly.Module(readFileSync(path.join(import.meta.dirname, 'indd.wasm')));
  // A fresh instance per document: its memory goes when the conversion does.
  const x = new WebAssembly.Instance(compiled, {}).exports as unknown as InddExports;
  const put = (b: Uint8Array) => {
    const at = x.alloc(b.length);
    new Uint8Array(x.memory.buffer, at, b.length).set(b);
    return at;
  };
  const label = new TextEncoder().encode(name);
  const n = x.convert(put(bytes), bytes.length, put(label), label.length);
  const out = new Uint8Array(x.memory.buffer, x.output(), Math.abs(n)).slice();
  const text = new TextDecoder();
  if (n < 0) throw new Error(text.decode(out) || 'It couldn’t be read.');
  const view = new DataView(out.buffer);
  let at = 0;
  const u32 = () => {
    const v = view.getUint32(at, true);
    at += 4;
    return v;
  };
  const chunk = () => {
    const len = u32();
    const b = out.subarray(at, at + len);
    at += len;
    return b;
  };
  const idml = chunk();
  const previews: Conversion['previews'] = [];
  for (let i = u32(); i > 0; i--) {
    const graphics: string[] = [];
    for (let j = u32(); j > 0; j--) graphics.push(text.decode(chunk()));
    previews.push({ graphics, data: chunk() });
  }
  const warnings: string[] = [];
  for (let i = u32(); i > 0; i--) warnings.push(text.decode(chunk()));
  return { idml, previews, warnings };
}

export function registerInddHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  ipcMain.handle('indd:convert', (event, bytes: unknown, name: unknown) => {
    assertShellSender(event);
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES) throw new Error('Not an InDesign document');
    return convert(bytes, typeof name === 'string' ? name : 'Untitled.indd');
  });
}
