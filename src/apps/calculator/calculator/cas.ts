import type { EvalResult, WorkerRequest, WorkerResponse } from './casProtocol';
import { GIAC_PRELUDE, isInternalName } from './toGiac';

export class BreakError extends Error {
  constructor() {
    super('Break');
  }
}

type Pending = { resolve: (response: WorkerResponse) => void; reject: (error: Error) => void };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command for the worker, before it gets its id. */
type Request = DistributiveOmit<WorkerRequest, 'id'>;

/**
 * One calculator's giac session, in a worker that starts on first use.
 * Commands run one at a time in order. break() is the TI-89's ON key: it
 * kills the worker mid-command, starts a fresh one, and restores what
 * `setup()` says the session had. dispose() stops the worker; using the
 * session again starts another the same way.
 */
export class Cas {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private busyCount = 0;

  /** `setup` gives the commands that rebuild the session (settings, variables) on a fresh worker. */
  constructor(private readonly setup: () => string[]) {}

  /** Whether a command is running. */
  get busy(): boolean {
    return this.busyCount > 0;
  }

  /** Called when busy changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private start() {
    const worker = new Worker(new URL('./giac.worker.ts', import.meta.url), { type: 'module', name: 'giac' });
    this.worker = worker;
    let resolveReady: () => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    const started = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === 'ready') {
        resolveReady();
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      const error = new Error(event.message || 'The calculator engine stopped');
      rejectReady(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    this.ready = started.then(async () => {
      await this.send({ type: 'run', codes: [...GIAC_PRELUDE, ...this.setup()] }, true);
    });
    // Nobody waits on `ready` until the first command; keep a failed start from being "unhandled".
    this.ready.catch(() => {});
  }

  private send(request: Request, skipReady = false): Promise<WorkerResponse> {
    if (!this.worker) this.start();
    const run = async () => {
      if (!skipReady) {
        // A break while waiting swaps in a new worker with its own start-up.
        let ready: Promise<void>;
        do {
          ready = this.ready;
          await ready;
        } while (ready !== this.ready);
      }
      const worker = this.worker;
      if (!worker) throw new Error('Closed');
      const id = this.nextId++;
      return new Promise<WorkerResponse>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        worker.postMessage({ ...request, id } as WorkerRequest);
      });
    };
    this.busyCount++;
    this.emit();
    return run().finally(() => {
      this.busyCount--;
      this.emit();
    });
  }

  /** Evaluate giac code, keeping the result in `store`; `simplify` tidies constant answers. */
  async evaluate(code: string, store: string, approx: boolean, simplify = true): Promise<EvalResult> {
    const response = await this.send({ type: 'eval', code, store, approx, simplify });
    if (response.type !== 'eval') throw new Error('Unexpected response');
    return response.result;
  }

  /** Run giac commands in order; each gives its printed result or an error. */
  async run(codes: string[]): Promise<({ out: string } | { error: string })[]> {
    if (codes.length === 0) return [];
    const response = await this.send({ type: 'run', codes });
    if (response.type !== 'run') throw new Error('Unexpected response');
    return response.results;
  }

  /** Run one command, throwing its error. */
  async run1(code: string): Promise<string> {
    const [result] = await this.run([code]);
    if ('error' in result) throw new Error(result.error);
    return result.out;
  }

  /** Values of a giac expression at each x, for what compile.ts can't graph. */
  async sample(expr: string, variable: string, xs: number[]): Promise<number[]> {
    const response = await this.send({ type: 'sample', expr, variable, xs });
    if (response.type !== 'sample') throw new Error('Unexpected response');
    return response.values;
  }

  /** The user's variables and what they hold, as giac source. */
  async variables(): Promise<Record<string, string>> {
    const names = (await this.run1('VARS()'))
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter((name) => name && !isInternalName(name));
    if (names.length === 0) return {};
    const values = await this.run(names.map((name) => `string(${name})`));
    const vars: Record<string, string> = {};
    names.forEach((name, i) => {
      const value = values[i];
      if ('out' in value) vars[name] = value.out.trim();
    });
    return vars;
  }

  /** Stop the running command: a new worker takes over, with the session restored. */
  break() {
    if (!this.busy) return;
    this.worker?.terminate();
    this.worker = null;
    const error = new BreakError();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.start();
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(new Error('Closed'));
    this.pending.clear();
  }
}
