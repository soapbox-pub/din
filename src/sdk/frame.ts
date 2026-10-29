/**
 * window.din for an app framed outside Electron (npm run dev:browser, a
 * static web deploy), where no preload provides it: the din-apps Vite plugin
 * makes this every app page's first script. Inside Electron the preload has
 * already defined window.din, and this does nothing.
 */
import { installDin, type Transport } from '@/sdk/runtime';

/** A port the desktop posts into the frame once asked; messages wait for it. */
function frameTransport(): Transport {
  let port: MessagePort | null = null;
  const outbox: unknown[] = [];
  const inbox: unknown[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const onMessage = (e: MessageEvent) => {
    if (e.source !== window.parent || (e.data as { type?: string } | null)?.type !== 'din:port' || !e.ports[0]) return;
    window.removeEventListener('message', onMessage);
    port = e.ports[0];
    port.onmessage = (m) => {
      if (listeners.size === 0) inbox.push(m.data);
      for (const l of listeners) l(m.data);
    };
    for (const message of outbox.splice(0)) port.postMessage(message);
  };
  window.addEventListener('message', onMessage);
  // Tell the desktop we're listening; it answers with the port.
  window.parent.postMessage({ type: 'din:hello' }, '*');
  return {
    post: (message) => (port ? port.postMessage(message) : outbox.push(message)),
    onMessage: (listener) => {
      listeners.add(listener);
      for (const m of inbox.splice(0)) listener(m);
      return () => listeners.delete(listener);
    },
  };
}

if (!('din' in window) && window.parent !== window) installDin(frameTransport());
