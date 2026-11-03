// NAP-RESOURCE (dinos-widgets:resource) must never fetch from this machine or
// its network, whichever way the address is written.

import os from 'node:os';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  fetch: vi.fn(async () => new Response('secret')),
}));

vi.mock('electron', () => {
  const session = {
    protocol: { handle: () => {} },
    registerPreloadScript: () => {},
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    webRequest: { onBeforeRequest: () => {} },
    on: () => {},
    fetch: state.fetch,
  };
  return {
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => state.handlers.set(channel, handler),
      on: () => {},
    },
    MessageChannelMain: class {},
    net: {},
    session: { fromPartition: () => session },
  };
});

const { registerWidgets } = await import('../widgets.mts');

beforeAll(() => {
  registerWidgets({ widgetsDir: os.tmpdir(), cacheDir: os.tmpdir(), shell: () => null, assertShellSender: () => {} }, '/dev/null');
});

function resource(url: string): Promise<unknown> {
  return Promise.resolve(state.handlers.get('dinos-widgets:resource')!({}, url));
}

describe('widget resources', () => {
  it.each([
    'https://1.1.1.1/',
    'https://[2606:4700:4700::1111]/',
    'https://[::ffff:8.8.8.8]/',
  ])('fetches %s', async (url) => {
    state.fetch.mockClear();
    await expect(resource(url)).resolves.toBeDefined();
    expect(state.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    'https://127.0.0.1/secret',
    'https://192.168.1.1/',
    'https://[::1]/secret',
  ])('refuses %s', async (url) => {
    state.fetch.mockClear();
    await expect(resource(url)).rejects.toThrow('Not a public address');
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['loopback, IPv4-mapped', 'https://[::ffff:127.0.0.1]/secret'],
    ['a router, IPv4-mapped', 'https://[::ffff:192.168.1.1]/'],
    ['10/8, IPv4-mapped', 'https://[::ffff:10.0.0.1]/'],
    ['loopback, IPv4-compatible', 'https://[::127.0.0.1]/secret'],
    ['loopback, NAT64', 'https://[64:ff9b::127.0.0.1]/secret'],
  ])('refuses %s (%s)', async (_name, url) => {
    state.fetch.mockClear();
    await expect(resource(url)).rejects.toThrow('Not a public address');
    expect(state.fetch).not.toHaveBeenCalled();
  });
});
