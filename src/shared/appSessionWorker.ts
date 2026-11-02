/** The SharedWorker behind src/shared/appSession.ts: one map per app origin, while a window of it is open. */

type Message = { type: 'get'; id: number; key: string } | { type: 'set'; key: string; value: unknown };

const store = new Map<string, unknown>();
const scope = self as unknown as { onconnect: ((e: MessageEvent) => void) | null };

scope.onconnect = (e) => {
  const port = e.ports[0];
  port.onmessage = ({ data }: MessageEvent<Message>) => {
    if (data.type === 'get') port.postMessage({ id: data.id, value: store.get(data.key) });
    else if (data.value === undefined) store.delete(data.key);
    else store.set(data.key, data.value);
  };
};
