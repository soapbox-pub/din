// The utility process Din's small background services run in (see
// services.mts). The main process sends `start` with a MessagePort; the
// service is loaded on first start and talks to its main-process side on
// that port alone.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import type { ServiceName, ServiceOptions } from './services.mts';

interface ServiceModule {
  start: (port: Electron.MessagePortMain, options: ServiceOptions) => void;
}

const SERVICES: Record<ServiceName, () => Promise<ServiceModule>> = {
  system: () => import('./system-worker.mts'),
  notifications: () => import('./notification-server.mts'),
  'file-chooser': () => import('./file-chooser-portal.mts'),
};

process.parentPort.on('message', (event) => {
  const { type, service, options } = event.data as {
    type: string;
    service: ServiceName;
    options: ServiceOptions;
  };
  const port = event.ports[0];
  if (type !== 'start' || !port || !Object.hasOwn(SERVICES, service)) return;
  SERVICES[service]()
    .then((module) => {
      module.start(port, options);
      port.start();
    })
    .catch((error: unknown) => {
      // One service failing to load mustn't take the others down.
      console.error(`services: ${service} failed to start:`, error);
      port.close();
    });
});
