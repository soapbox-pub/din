// Din says so when a disk is filling up, since nobody keeps the System
// Monitor open to see it: every few minutes / and /home are measured
// (proc-stats.mts, at the levels the System Monitor shows), and a
// filesystem that gets low, then critical, gets a notification for each.
// It's told again only after it's had room again. An installed DinOS's
// system volume is left out (systemManagedByNix).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fsp from 'node:fs/promises';
import { notifyFromSystem } from './notifications.mts';
import { readFilesystems, type FilesystemSpace, type SpaceLevel } from './proc-stats.mts';

const CHECK_MS = 5 * 60_000;
const RANK: Record<SpaceLevel, number> = { ok: 0, low: 1, critical: 2 };

/** The worst level each filesystem has been told about, by mount point. */
const told = new Map<string, SpaceLevel>();
let watching = false;

/** In GB as Din shows them everywhere (src/lib/fs.ts's formatBytes): 1024³ bytes. */
function formatGb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/**
 * Whether / is a system volume Nix looks after: home is its own filesystem
 * and / holds the Nix store. On an installed DinOS root sits near full by
 * design, and Nix's garbage collection (min-free/max-free and nix.gc in
 * os/configuration.nix) keeps room in it, so it's nothing to tell anyone.
 */
async function systemManagedByNix(filesystems: FilesystemSpace[]): Promise<boolean> {
  if (!filesystems.some((fs) => fs.mountPoint === '/home')) return false;
  try {
    const [root, store] = await Promise.all([fsp.stat('/'), fsp.stat('/nix/store')]);
    return root.dev === store.dev;
  } catch {
    return false;
  }
}

async function check(): Promise<void> {
  const filesystems = await readFilesystems();
  const skipSystem = await systemManagedByNix(filesystems);
  for (const fs of filesystems) {
    if (skipSystem && fs.mountPoint === '/') continue;
    const last = told.get(fs.mountPoint) ?? 'ok';
    if (fs.level === 'ok') {
      told.delete(fs.mountPoint);
      continue;
    }
    if (RANK[fs.level] <= RANK[last]) continue;
    told.set(fs.mountPoint, fs.level);
    const name = fs.label === 'Home' ? 'Your home disk' : `Your ${fs.label.toLowerCase()} disk`;
    notifyFromSystem(
      `disk-space:${fs.mountPoint}`,
      fs.level === 'critical' ? `${name} is running out of space` : `${name} is almost full`,
      `${formatGb(fs.free)} left of ${formatGb(fs.total)}.`,
    );
  }
}

/** Start watching the disks' free space, once the desktop is on screen. */
export function watchDiskSpace(): void {
  if (watching) return;
  watching = true;
  const run = () => void check().catch((error) => console.warn('[disk-space] check failed:', error));
  run();
  setInterval(run, CHECK_MS);
}
