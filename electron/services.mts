// Din's small background services - system tools (system-worker.mts), the
// notification server (notification-server.mts) and the file chooser portal
// (file-chooser-portal.mts) - share one utility process, services-host.mts.
// Each wants a process of its own only to stay off the main process's
// thread, not away from each other, and every Node process costs ~40 MB
// before it does anything.
//
// Each service talks to its main-process side over a MessagePort of its
// own, so the sides never see each other's messages. If the host dies,
// every service hears it as its exit, and the next one started forks a new
// host.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import path from 'node:path';
import { app, MessageChannelMain, utilityProcess } from 'electron';

// .mts in development, the compiled .mjs in a build (scripts/build-electron.mjs).
const HOST = path.join(import.meta.dirname, `services-host${path.extname(import.meta.filename)}`);

export type ServiceName = 'system' | 'notifications' | 'file-chooser';

/** What a service is started with, in the host. */
export interface ServiceOptions {
  /** The session bus to serve on (the D-Bus services). */
  busAddress?: string;
}

/** A running service, as its main-process side holds it. */
export interface Service {
  postMessage: (message: unknown) => void;
}

let host: Electron.UtilityProcess | null = null;
/** Every running service's exit, called when the host dies. */
const exits = new Set<() => void>();

/** The host, forked on first use (and again after it dies). */
function servicesHost(): Electron.UtilityProcess {
  if (host) return host;
  const child = utilityProcess.fork(HOST, [], { serviceName: 'Din services', stdio: 'inherit' });
  child.once('exit', () => {
    if (host === child) host = null;
    for (const exit of [...exits]) exit();
  });
  host = child;
  return child;
}

app.on('will-quit', () => host?.kill());

/**
 * Start `name` in the services host. `onMessage` gets what it posts;
 * `onExit` is called once, if the host dies under it or the service
 * couldn't start.
 */
export function startService<Message>(
  name: ServiceName,
  options: ServiceOptions,
  handlers: { onMessage: (message: Message) => void; onExit: () => void },
): Service {
  const { port1, port2 } = new MessageChannelMain();
  servicesHost().postMessage({ type: 'start', service: name, options }, [port1]);
  let ended = false;
  const exit = () => {
    if (ended) return;
    ended = true;
    exits.delete(exit);
    port2.close();
    handlers.onExit();
  };
  exits.add(exit);
  port2.on('message', (event) => handlers.onMessage(event.data as Message));
  // The host closes the port when the service failed to load.
  port2.on('close', exit);
  port2.start();
  return {
    postMessage: (message) => {
      if (!ended) port2.postMessage(message);
    },
  };
}
