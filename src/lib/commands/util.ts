import { CommandError, type Command, type Param } from './types';

/** A system bridge, or the error that it isn't on this computer. */
export function need<T>(bridge: T | undefined, what: string): T {
  if (!bridge) throw new CommandError(`${what} isn’t available here`);
  return bridge;
}

/** Electron's IPC wrapper off an error, for the command line. */
export function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** One command of an area. */
export function command(
  area: string,
  verb: string,
  summary: string,
  params: Param[],
  run: Command['run'],
): Command {
  return { path: [area, verb], summary, params, run };
}

/**
 * Pick one of several things by id (the first of its keys), or by a name
 * that matches only it (case-insensitively, whole or in part). An id wins
 * over a name, so `calculator` is Din's Calculator even beside a Linux app
 * called Calculator.
 */
export function pick<T>(items: readonly T[], query: string, keys: (item: T) => (string | number | null | undefined)[], what: string): T {
  const q = query.toLowerCase();
  const byId = items.filter((item) => {
    const id = keys(item)[0];
    return id !== null && id !== undefined && String(id).toLowerCase() === q;
  });
  if (byId.length === 1) return byId[0];
  const exact = items.filter((item) => keys(item).some((k) => k !== null && k !== undefined && String(k).toLowerCase() === q));
  if (exact.length === 1) return exact[0];
  const partial = exact.length > 1 ? exact : items.filter((item) => keys(item).some((k) => typeof k === 'string' && k.toLowerCase().includes(q)));
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) throw new CommandError(`No ${what} matches “${query}”`);
  throw new CommandError(`“${query}” matches more than one ${what}; use its id`);
}

/** Await a bridge call, its error cleaned for the command line. */
export async function call<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw new CommandError(cleanError(error));
  }
}

/** Make a command its area's own: `din <area> [arguments]`. */
export function bare(command: Command): Command {
  return { ...command, bare: true };
}
