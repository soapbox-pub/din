// An app granted `assistant` (CAD has it, src/apps/cad/manifest.webmanifest,
// and built-in apps get their manifest's permissions unasked) must not be
// able to answer sudo: approving is the user's click on the Assistant's card,
// which only `assistant-sudo` reaches.
//
// The real bridge (din-apps.mts) and the real askpass handlers (askpass.mts).
// A request only gets onto the socket from root's din-password under a real
// sudo (SO_PEERCRED), which a test can't be, so this checks what reaches the
// handlers. The shell's sender check is main's (main.mts isShellSender): a
// bridge event, or the shell itself.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Listener = (message: { data: unknown }) => void;
interface FakePort { listeners: Listener[]; sent: { id?: number; result?: unknown; error?: unknown }[] }

const state = vi.hoisted(() => {
  const runtimeDir = `${process.env.TMPDIR ?? '/tmp'}/din-askpass-test-${process.pid}`;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  return {
    runtimeDir,
    sessions: new Map<string, object>(),
    ports: [] as FakePort[],
    contents: new Map<number, unknown>(),
  };
});

vi.mock('electron', () => {
  class MessageChannelMain {
    port1: FakePort & { on: (event: string, cb: Listener) => void; postMessage: (m: never) => void; start: () => void; close: () => void };
    port2 = {};
    constructor() {
      const port: FakePort = { listeners: [], sent: [] };
      state.ports.push(port);
      this.port1 = {
        ...port,
        on: (_event, cb) => port.listeners.push(cb),
        postMessage: (m) => port.sent.push(m),
        start: () => {},
        close: () => {},
      };
    }
  }
  const fromPartition = (partition: string) => {
    let s = state.sessions.get(partition);
    if (!s) {
      s = {
        protocol: { handle: () => {} },
        registerPreloadScript: () => {},
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
        setDisplayMediaRequestHandler: () => {},
      };
      state.sessions.set(partition, s);
    }
    return s;
  };
  return {
    app: { on: () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    MessageChannelMain,
    net: {},
    protocol: { handle: () => {} },
    session: { fromPartition },
    webContents: { fromId: (id: number) => state.contents.get(id) },
  };
});

const { invokeHandlers } = await import('../ipc-registry.mts');
const { registerDinApps, isBridgeEvent, appsSession } = await import('../din-apps.mts');
const { registerAskpass } = await import('../askpass.mts');

const SHELL_EVENT = { shell: true };
const isShellSender = (event: unknown) => isBridgeEvent(event) || event === SHELL_EVENT;
const assertShellSender = (event: unknown) => {
  if (!isShellSender(event)) throw new Error('unauthorized sender');
};

const shell = { id: 1 };
const CAD_WC = 7;

beforeAll(async () => {
  fs.mkdirSync(state.runtimeDir, { recursive: true });
  state.contents.set(CAD_WC, {
    id: CAD_WC,
    isDestroyed: () => false,
    getType: () => 'webview',
    session: appsSession(),
    hostWebContents: shell,
    getURL: () => 'din://cad/',
    mainFrame: { postMessage: () => {} },
  });
  const opts = {
    distDir: state.runtimeDir,
    devUrl: undefined,
    shell: () => shell as unknown as Electron.WebContents,
    assertShellSender,
    isShellSender,
    protectedPaths: () => [],
    serveLaunched: () => null,
  };
  registerDinApps(opts, '/dev/null');
  registerAskpass({ sendToShell: () => {}, hasShell: () => true, assertShellSender });
  const socket = path.join(state.runtimeDir, 'din-askpass.sock');
  await vi.waitFor(() => expect(fs.existsSync(socket)).toBe(true));
});

afterAll(() => {
  fs.rmSync(state.runtimeDir, { recursive: true, force: true });
});

/** A call CAD makes on its `assistant` port, as din-app-preload.cjs sends it. */
async function call(port: FakePort, id: number, channel: string, args: unknown[]) {
  for (const listener of port.listeners) listener({ data: { id, channel, args } });
  await vi.waitFor(() => expect(port.sent.some((m) => m.id === id)).toBe(true));
  return port.sent.find((m) => m.id === id)!;
}

describe('the assistant bridge', () => {
  it("doesn't let an app approve sudo for the user", async () => {
    // The desktop opens CAD and grants it its manifest's `assistant`.
    await invokeHandlers.get('dinos-apps:grant')!(SHELL_EVENT as never, CAD_WC, 'assistant');
    const port = state.ports.at(-1)!;

    // CAD (code running in din://cad, say from a crafted drawing) looks for
    // requests and answers one for the whole conversation, and failing that,
    // guesses its id (they count up from 1).
    const listed = await call(port, 1, 'assistant:passwords', []);
    expect(listed.error).toBeDefined();
    for (let id = 1; id <= 5; id++) {
      const reply = await call(port, 1 + id, 'assistant:approve', [id, 'conversation']);
      expect(reply.error).toBeDefined();
    }
    const typed = await call(port, 7, 'assistant:answerPassword', [1, 'hunter2', true]);
    expect(typed.error).toBeDefined();
  });

  it('lets the Assistant answer, with assistant-sudo', async () => {
    await invokeHandlers.get('dinos-apps:grant')!(SHELL_EVENT as never, CAD_WC, 'assistant-sudo');
    const port = state.ports.at(-1)!;

    const listed = await call(port, 1, 'assistant:passwords', []);
    expect(listed.error).toBeUndefined();
    expect(listed.result).toEqual([]);
  });
});
