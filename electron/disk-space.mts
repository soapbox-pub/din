// Din says so when a disk is filling up, since nobody keeps the System
// Monitor open to see it: every few minutes /home is measured
// (proc-stats.mts, at the levels the System Monitor shows), and when it
// gets low, then critical, it gets a notification for each. It's told
// again only after it's had room again.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { notifyFromSystem } from './notifications.mts';
import { readFilesystems, type SpaceLevel } from './proc-stats.mts';

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

async function check(): Promise<void> {
  const filesystems = await readFilesystems();
  for (const fs of filesystems) {
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
