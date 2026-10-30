// Argon2 for the password vault (passwords.mts), in a worker thread.
//
// Electron's Node is built on BoringSSL, whose crypto has no Argon2, so it
// comes from hash-wasm. Deriving a vault's key takes a good fraction of a
// second on purpose, which on the main thread would stall input routing for
// the whole desktop; main starts one of these per derivation.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { parentPort, workerData } from 'node:worker_threads';
import { argon2d, argon2id } from 'hash-wasm';

export interface KdfRequest {
  password: Uint8Array;
  salt: Uint8Array;
  /** KiB. */
  memory: number;
  iterations: number;
  length: number;
  parallelism: number;
  /** 0 for Argon2d, 2 for Argon2id (kdbxweb's numbering). */
  type: number;
}

const request = workerData as KdfRequest;
const derive = request.type === 2 ? argon2id : argon2d;
derive({
  password: request.password,
  salt: request.salt,
  memorySize: request.memory,
  iterations: request.iterations,
  hashLength: request.length,
  parallelism: request.parallelism,
  outputType: 'binary',
}).then(
  (key) => parentPort?.postMessage({ key }),
  (error: unknown) => parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }),
);
