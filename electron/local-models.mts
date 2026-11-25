// The local models bridge (window.dinos.localModels, for Settings → Assistant
// and `din assistant models`): AI models that run on this computer, through
// Ollama.
//
// Ollama is DinOS's `local-ai` optional feature, which comes with the
// computer (os/configuration.nix; DIN_OLLAMA names its binary), or the
// system's `ollama` elsewhere. Din starts its server when Din starts, on
// Ollama's usual 127.0.0.1:11434, where OpenCode's own Ollama provider finds
// it with no setup and adds the models it has to the assistant's list, and
// where `ollama` in a Terminal finds it too. Idle, the server is a few tens
// of megabytes; a model is loaded only while it's being used, and for five
// minutes after. A server already answering there (one the system runs) is
// used as it is.
//
// The server Din starts uses integrated GPUs, which Ollama leaves alone
// unless asked (OLLAMA_IGPU_ENABLE): on a laptop, that's the difference
// between a model that answers and one that crawls. Each model gets a
// context window of CONTEXT tokens, room for the agent's instructions and
// tools with a conversation besides; Ollama's own default would cut them
// off. Its cloud models are off: these are the ones on this computer.
//
// What the GPU has to give is what Ollama found, from the lines it logs at
// start ("inference compute"), so Settings can say which models fit here.
// The system's server's log isn't Din's to read, so with that one nothing
// is known of the GPU, and Settings goes by the computer's memory alone.
// Models are downloaded with /api/pull, kept in ~/.ollama/models, and
// removed with /api/delete; a download stopped part way picks up where it
// left off.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { app, ipcMain } from 'electron';
import { which } from './system.mts';

const HOST = '127.0.0.1:11434';
const BASE = `http://${HOST}`;
/** Tokens of context each model is given (OLLAMA_CONTEXT_LENGTH). */
export const CONTEXT = 32_768;
/** How often Din looks for the binary (installed since) or a server that went away. */
const WATCH_MS = 60_000;
const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Progress goes to the shell at most this often. */
const EMIT_MS = 250;
/** A model's name as Ollama takes it: "qwen3.6:35b-a3b", "hf.co/org/repo:q4". */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,199}$/;

export interface LocalGpu {
  name: string;
  /** Integrated GPUs share the computer's memory; discrete ones have their own. */
  kind: 'integrated' | 'discrete';
  /** What it has for models, in bytes. */
  memory: number;
}

export interface LocalModel {
  /** Ollama's name for it, with its tag ("qwen3.6:35b-a3b"). */
  name: string;
  /** On disk, in bytes. */
  size: number;
  modifiedAt: string;
  /** "35.9B", from its metadata, when Ollama says. */
  parameters: string | null;
  quantization: string | null;
  /** Whether it can call tools, which the assistant needs; null when unknown. */
  tools: boolean | null;
  /** In memory now. */
  loaded: boolean;
}

export interface LocalPull {
  model: string;
  /** Ollama's words for what it's doing ("pulling manifest", "verifying sha256 digest"). */
  status: string;
  completed: number;
  /** Bytes in all; 0 until it knows. */
  total: number;
  error: string | null;
}

export interface LocalModelsState {
  /** Ollama is here: its binary, or a server answering. */
  available: boolean;
  running: boolean;
  /** The server isn't Din's (the system runs one). */
  external: boolean;
  /** Ollama's version ("0.40.3"): models say which they need. */
  version: string | null;
  /** The computer's memory, in bytes. */
  memory: number;
  /** The GPU Ollama runs models on, or null for the CPU (or when it's not known). */
  gpu: LocalGpu | null;
  /** Tokens of context each model gets. */
  context: number;
  models: LocalModel[];
  pulls: LocalPull[];
  error: string | null;
}

let binary: string | null = null;
let child: ChildProcess | null = null;
let running = false;
let external = false;
let gpu: LocalGpu | null = null;
let version: string | null = null;
let lastError: string | null = null;
let starting: Promise<void> | null = null;
let restarts = 0;
const pulls = new Map<string, LocalPull & { abort: AbortController }>();
/** Tools capability by model and digest: /api/show is asked once for each. */
const capabilities = new Map<string, boolean | null>();
let emit: () => void = () => {};

function findBinary(): string | null {
  const named = process.env.DIN_OLLAMA;
  if (named) return fs.existsSync(named) ? named : null;
  return which('ollama');
}

async function answers(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => ({}))) as { version?: unknown };
    version = typeof body.version === 'string' ? body.version : null;
    return true;
  } catch {
    return false;
  }
}

/** Bytes from Ollama's "35.3 GiB". */
function parseBytes(value: string, unit: string): number {
  const n = Number(value);
  const scale = unit.startsWith('G') ? 1024 ** 3 : unit.startsWith('M') ? 1024 ** 2 : unit.startsWith('K') ? 1024 : 1;
  return Math.round(n * scale);
}

/**
 * The GPU in one of the lines Ollama logs at start:
 * msg="inference compute" id=0 library=Vulkan … description="AMD Radeon 890M (RADV STRIX1)" … type=iGPU total="35.3 GiB"
 * The biggest of several wins; the CPU's line isn't one.
 */
function readComputeLine(line: string): void {
  if (!line.includes('inference compute')) return;
  const field = (name: string) => new RegExp(`\\b${name}=("([^"]*)"|\\S+)`).exec(line);
  const library = field('library');
  if (!library || /^"?cpu"?$/i.test(library[2] ?? library[1])) return;
  const total = /\btotal="([\d.]+) ([KMG]i?B)"/.exec(line);
  if (!total) return;
  const description = field('description');
  const name = field('name');
  const type = field('type');
  const found: LocalGpu = {
    name: description?.[2] ?? description?.[1] ?? name?.[2] ?? name?.[1] ?? 'GPU',
    kind: /igpu/i.test(type?.[1] ?? '') ? 'integrated' : 'discrete',
    memory: parseBytes(total[1], total[2]),
  };
  if (!gpu || found.memory > gpu.memory) gpu = found;
}

async function waitUntilAnswering(server: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('Ollama stopped while starting');
    if (await answers()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Ollama took too long to start');
}

function startServer(path: string): Promise<void> {
  gpu = null;
  const server = spawn(path, ['serve'], {
    env: {
      ...process.env,
      OLLAMA_HOST: HOST,
      OLLAMA_IGPU_ENABLE: '1',
      OLLAMA_CONTEXT_LENGTH: String(CONTEXT),
      OLLAMA_FLASH_ATTENTION: '1',
      OLLAMA_NO_CLOUD: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child = server;
  let tail = '';
  let partial = '';
  server.stderr?.on('data', (chunk: Buffer) => {
    const text = partial + chunk.toString();
    const lines = text.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      readComputeLine(line);
      tail = (tail + line + '\n').slice(-4000);
    }
    // Ollama logs whatever it's asked; only what's needed stays.
    if (partial.length > 8000) partial = '';
  });
  server.on('error', () => {});
  server.on('exit', (code, signal) => {
    if (child !== server) return;
    child = null;
    running = false;
    if (signal !== 'SIGTERM') {
      lastError = 'Ollama stopped';
      console.error(`[local-models] ollama exited (${signal ?? code}):\n${tail.trim()}`);
    }
    emit();
  });
  return waitUntilAnswering(server);
}

/** The server answering, Din's or the system's; Din's started where neither is. */
function ensureServer(): Promise<void> {
  starting ??= (async () => {
    try {
      if (running && (await answers())) return;
      binary = findBinary();
      if (child && (await answers())) {
        running = true;
        return;
      }
      if (!child && (await answers())) {
        running = true;
        external = true;
        return;
      }
      if (!binary) {
        running = false;
        return;
      }
      external = false;
      await startServer(binary);
      running = true;
      lastError = null;
    } catch (error) {
      running = false;
      lastError = error instanceof Error ? error.message : String(error);
      child?.kill('SIGTERM');
      child = null;
      throw error;
    } finally {
      starting = null;
      emit();
    }
  })();
  return starting;
}

async function api(method: string, apiPath: string, body?: unknown, timeout = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const response = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = typeof data === 'object' && data && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : `Ollama answered ${response.status}`;
    throw new Error(message);
  }
  return data;
}

/** Whether a model can call tools, from its capabilities. */
async function toolsOf(name: string, digest: string): Promise<boolean | null> {
  const key = `${name}@${digest}`;
  if (capabilities.has(key)) return capabilities.get(key) ?? null;
  try {
    const shown = (await api('POST', '/api/show', { model: name })) as { capabilities?: unknown };
    const tools = Array.isArray(shown.capabilities) ? shown.capabilities.includes('tools') : null;
    capabilities.set(key, tools);
    return tools;
  } catch {
    return null;
  }
}

async function listModels(): Promise<LocalModel[]> {
  if (!running) return [];
  const [tags, ps] = await Promise.all([
    api('GET', '/api/tags') as Promise<{ models?: Record<string, unknown>[] }>,
    (api('GET', '/api/ps') as Promise<{ models?: Record<string, unknown>[] }>).catch(() => ({ models: [] })),
  ]);
  const loaded = new Set((ps.models ?? []).map((m) => String(m.name ?? m.model ?? '')));
  const models = (tags.models ?? []).filter((m) => typeof m.name === 'string' && !(m as { remote_host?: unknown }).remote_host);
  return Promise.all(
    models.map(async (m) => {
      const name = m.name as string;
      const details = (m.details ?? {}) as Record<string, unknown>;
      return {
        name,
        size: typeof m.size === 'number' ? m.size : 0,
        modifiedAt: typeof m.modified_at === 'string' ? m.modified_at : '',
        parameters: typeof details.parameter_size === 'string' && details.parameter_size ? details.parameter_size : null,
        quantization: typeof details.quantization_level === 'string' && details.quantization_level ? details.quantization_level : null,
        tools: await toolsOf(name, typeof m.digest === 'string' ? m.digest : ''),
        loaded: loaded.has(name),
      };
    }),
  );
}

async function state(): Promise<LocalModelsState> {
  // Started, or found answering (the system's, a container's), if it isn't yet.
  if (!starting && !running) await ensureServer().catch(() => {});
  else if (starting) await starting.catch(() => {});
  let models: LocalModel[] = [];
  let error = lastError;
  try {
    models = await listModels();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return snapshot(models, error);
}

function snapshot(models: LocalModel[], error: string | null): LocalModelsState {
  return {
    available: Boolean(binary ?? findBinary()) || running,
    running,
    external,
    version,
    memory: os.totalmem(),
    gpu,
    context: CONTEXT,
    models,
    pulls: [...pulls.values()].map(({ model, status, completed, total, error: e }) => ({ model, status, completed, total, error: e })),
    error,
  };
}

/** Download a model; resolves once it's ready, rejects if it failed or was stopped. */
async function pull(model: string): Promise<void> {
  if (pulls.get(model) && !pulls.get(model)!.error) throw new Error(`${model} is already downloading`);
  await ensureServer();
  if (!running) throw new Error('Ollama isn’t installed');
  const abort = new AbortController();
  const entry = { model, status: 'starting', completed: 0, total: 0, error: null as string | null, abort };
  pulls.set(model, entry);
  emit();
  // Each layer's size and how much of it is here, for one figure across them.
  const layers = new Map<string, { total: number; completed: number }>();
  let lastEmit = 0;
  try {
    const response = await fetch(`${BASE}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: abort.signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let message = `Ollama answered ${response.status}`;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message;
      } catch {
        // Not JSON.
      }
      throw new Error(message);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const update = JSON.parse(line) as { status?: string; digest?: string; total?: number; completed?: number; error?: string };
        if (update.error) throw new Error(update.error);
        if (update.status) entry.status = update.status;
        if (update.digest && typeof update.total === 'number') {
          layers.set(update.digest, { total: update.total, completed: update.completed ?? 0 });
          entry.total = [...layers.values()].reduce((sum, l) => sum + l.total, 0);
          entry.completed = [...layers.values()].reduce((sum, l) => sum + l.completed, 0);
        }
        if (Date.now() - lastEmit > EMIT_MS) {
          lastEmit = Date.now();
          emit();
        }
      }
    }
    if (entry.status !== 'success') throw new Error('The download didn’t finish');
    pulls.delete(model);
  } catch (error) {
    if (abort.signal.aborted) {
      pulls.delete(model);
      throw new Error('Stopped', { cause: error });
    }
    entry.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    emit();
  }
}

function cancel(model: string): void {
  pulls.get(model)?.abort.abort();
  // One that failed is let go of.
  if (pulls.get(model)?.error) {
    pulls.delete(model);
    emit();
  }
}

async function remove(model: string): Promise<void> {
  await ensureServer();
  await api('DELETE', '/api/delete', { model });
  emit();
}

function validName(value: unknown): string {
  if (typeof value !== 'string' || !MODEL_NAME.test(value.trim())) throw new Error('That isn’t a model’s name');
  return value.trim();
}

function watch(): void {
  // After a crash, a few tries; the next WATCH_MS tick after that.
  if (!running && !starting && findBinary()) {
    if (restarts++ < 5 || restarts % 10 === 0) void ensureServer().catch(() => {});
  } else if (running) {
    restarts = 0;
  }
}

export function registerLocalModelsHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender, sendToShell } = options;
  let pending: ReturnType<typeof setTimeout> | null = null;
  emit = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      void listModels()
        .catch(() => [])
        .then((models) => sendToShell('local-models:changed', snapshot(models, lastError)));
    }, 50);
  };

  ipcMain.handle('local-models:state', (event) => {
    assertShellSender(event);
    return state();
  });

  ipcMain.handle('local-models:pull', (event, model: unknown) => {
    assertShellSender(event);
    return pull(validName(model));
  });

  ipcMain.handle('local-models:cancel', (event, model: unknown) => {
    assertShellSender(event);
    cancel(validName(model));
  });

  ipcMain.handle('local-models:remove', (event, model: unknown) => {
    assertShellSender(event);
    return remove(validName(model));
  });

  // Running from the start, so the assistant has its models wherever it's asked.
  void app.whenReady().then(() => {
    setTimeout(() => void ensureServer().catch(() => {}), 3_000);
    setInterval(watch, WATCH_MS).unref();
  });

  app.on('will-quit', () => {
    for (const p of pulls.values()) p.abort.abort();
    child?.kill('SIGTERM');
    child = null;
  });
}
