import { useSyncExternalStore } from 'react';
import {
  getUserscriptsBridge,
  parseUserscriptMeta,
  type Userscript,
  type UserscriptsBridge,
} from '@/lib/userscripts';

/** Where the library was kept before the main process kept it. */
const LEGACY_KEY = 'din:browser:userscripts';

const NONE: Userscript[] = [];

// One copy of what's installed for the whole desktop, however many browser
// windows are showing it.
let scripts = NONE;
/** Counts what main has told us, so an older answer never replaces a newer one. */
let told = 0;
let ready: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: Userscript[]) {
  scripts = next;
  told += 1;
  for (const listener of listeners) listener();
}

/**
 * Give the main process the library this device kept in localStorage, and
 * drop it from there once main has it: megabytes of script that the browser
 * otherwise holds in memory for as long as the desktop is open.
 */
async function handOver(bridge: UserscriptsBridge) {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (raw === null) return;
  let legacy: unknown = null;
  try {
    legacy = JSON.parse(raw);
  } catch {
    // Unreadable, so it was already showing as an empty library.
  }
  if (!Array.isArray(legacy) || (await bridge.adopt(legacy))) localStorage.removeItem(LEGACY_KEY);
}

/** Start following what's installed: once, on first use. */
function start(): Promise<void> {
  ready ??= (async () => {
    const bridge = getUserscriptsBridge();
    if (!bridge) return;
    bridge.onChanged(set);
    try {
      await handOver(bridge);
    } catch (error) {
      console.warn('Failed to hand over userscripts:', error);
    }
    const before = told;
    try {
      const list = await bridge.list();
      if (told === before) set(list);
    } catch (error) {
      console.warn('Failed to load userscripts:', error);
    }
  })();
  return ready;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void start();
  return () => {
    listeners.delete(listener);
  };
}

function snapshot() {
  return scripts;
}

/** The bridge, once the library from before it is where a change can't lose it. */
async function library(): Promise<UserscriptsBridge> {
  const bridge = getUserscriptsBridge();
  if (!bridge) throw new Error('Userscripts are only available in Din');
  await start();
  return bridge;
}

/**
 * Install (or update) a script from its source text. Re-installing a script
 * with the same download URL, or the same name + namespace, replaces the
 * existing entry in place, keeping its id and enabled state.
 * Rejects when the source has no valid ==UserScript== block.
 */
async function install(code: string, downloadUrl?: string): Promise<Userscript> {
  const meta = parseUserscriptMeta(code);
  if (!meta) {
    throw new Error('Missing or invalid ==UserScript== metadata block');
  }
  return (await library()).install({ ...meta, code, downloadUrl });
}

async function remove(id: string): Promise<void> {
  await (await library()).remove(id);
}

async function setEnabled(id: string, enabled: boolean): Promise<void> {
  await (await library()).setEnabled(id, enabled);
}

/**
 * The browser's userscript library. The main process keeps it, per device,
 * and injects matching scripts into browser tabs (see src/lib/userscripts.ts);
 * here is what's installed, without the scripts' code, and the ways to change
 * it, each resolving once the change is saved.
 */
export function useUserscripts() {
  const scripts = useSyncExternalStore(subscribe, snapshot);
  return { scripts, install, remove, setEnabled };
}
