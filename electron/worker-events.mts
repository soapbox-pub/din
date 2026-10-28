// Raising events in a site's service worker, for the runtimes that wake one
// (napp.mts for installed nsites, web-push.mts for websites).
//
// Events reach a worker the way Electron allows a host to: the worker is
// started for its scope, kept alive with a task while it handles one event,
// and handed the event over IPC (`<prefix>:dispatch`); its preload dispatches
// it as a real PushEvent/NotificationEvent/... and answers
// `<prefix>:dispatched` once what it gave waitUntil() has settled. One event
// at a time per site, five minutes at most each.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

/** How long one event may keep a worker busy (Chromium's own ceiling). */
const DISPATCH_TIMEOUT_MS = 5 * 60_000;
/** Events waiting for a site's worker before new ones are dropped. */
const MAX_QUEUED = 100;

/**
 * What became of an event: its handlers ran (and what they waited on
 * settled), they threw or took too long, or the site has no worker.
 */
export type DispatchResult = 'handled' | 'failed' | 'no-worker';

export interface WorkerEventsOptions {
  /** The IPC channels' prefix, as the worker's preload uses it. */
  prefix: string;
  log: (line: string) => void;
  /** What became of an event, for diagnosis; `site` is the caller's key. */
  onOutcome?: (site: string, type: string, outcome: string, ms: number) => void;
  /** A worker was started for an event: the caller's own IPC goes on it here. */
  onWorker?: (worker: Electron.ServiceWorkerMain) => void;
}

export class WorkerEvents {
  readonly #options: WorkerEventsOptions;
  readonly #attached = new WeakSet<Electron.ServiceWorkerMain>();
  readonly #pending = new Map<number, (ok: boolean) => void>();
  readonly #queues = new Map<string, { tail: Promise<void>; length: number }>();
  #nextId = 1;

  constructor(options: WorkerEventsOptions) {
    this.#options = options;
  }

  /** Listen for a worker's answers; harmless to call again. */
  attach(worker: Electron.ServiceWorkerMain): void {
    if (this.#attached.has(worker)) return;
    this.#attached.add(worker);
    worker.ipc.on(`${this.#options.prefix}:dispatched`, (_event, id, ok) => {
      const resolve = typeof id === 'number' ? this.#pending.get(id) : undefined;
      if (!resolve) return;
      this.#pending.delete(id);
      resolve(ok === true);
    });
  }

  /**
   * Start the worker for `scope` in `s` (if there is one) and raise an event
   * in it. `site` names it in the log.
   */
  async dispatch(
    s: Electron.Session,
    scope: string,
    site: string,
    type: string,
    init: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const started = Date.now();
    const outcome = (what: string): void => {
      const ms = Date.now() - started;
      this.#options.log(`${site}: ${type} ${what} (${ms} ms)`);
      this.#options.onOutcome?.(site, type, what, ms);
    };
    let worker: Electron.ServiceWorkerMain;
    try {
      worker = await s.serviceWorkers.startWorkerForScope(scope);
    } catch (error) {
      outcome(`not delivered, no worker: ${error instanceof Error ? error.message : error}`);
      return 'no-worker';
    }
    this.attach(worker);
    this.#options.onWorker?.(worker);
    const task = worker.startTask();
    const id = this.#nextId++;
    try {
      const ok = await new Promise<boolean | 'timeout' | 'unsent'>((resolve) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          resolve('timeout');
        }, DISPATCH_TIMEOUT_MS);
        this.#pending.set(id, (ok) => {
          clearTimeout(timer);
          resolve(ok);
        });
        try {
          worker.send(`${this.#options.prefix}:dispatch`, id, type, init);
        } catch {
          clearTimeout(timer);
          this.#pending.delete(id);
          resolve('unsent');
        }
      });
      if (ok === 'timeout') outcome('timed out');
      else if (ok === 'unsent') outcome('could not be sent to the worker');
      else outcome(ok ? 'handled' : 'failed in the worker');
      return ok === true ? 'handled' : 'failed';
    } finally {
      task.end();
    }
  }

  /**
   * Run jobs for a site's worker one after another. Returns false when
   * MAX_QUEUED are already waiting, and the job was dropped.
   */
  enqueue(site: string, job: () => Promise<unknown>): boolean {
    let queue = this.#queues.get(site);
    if (!queue) {
      queue = { tail: Promise.resolve(), length: 0 };
      this.#queues.set(site, queue);
    }
    if (queue.length >= MAX_QUEUED) {
      this.#options.log(`${site}: ${MAX_QUEUED} events already waiting for the worker; dropped one`);
      return false;
    }
    queue.length++;
    const q = queue;
    q.tail = q.tail
      .then(async () => {
        await job();
      })
      .catch(() => {})
      .finally(() => {
        q.length--;
        if (q.length === 0 && this.#queues.get(site) === q) this.#queues.delete(site);
      });
    return true;
  }

  /** Stop waiting on a site's queue (what's running finishes). */
  forget(site: string): void {
    this.#queues.delete(site);
  }
}
