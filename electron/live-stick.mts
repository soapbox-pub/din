// Running live from a USB stick, Din says so when the stick is slow: that's
// why everything is, and installing fixes it. os/configuration.nix measures
// the stick once the desktop is up (dinos-live-speed) and leaves the verdict
// in /run/din/stick-speed; this waits for it and posts a notification.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import { notifyFromSystem } from './notifications.mts';

const LIVE_FILE = '/run/din/live';
const SPEED_FILE = '/run/din/stick-speed';
const POLL_MS = 5_000;
/** The measurement starts 20 s after boot; it's given plenty of room. */
const GIVE_UP_MS = 10 * 60_000;

/** Start waiting for the stick's verdict, once the desktop is on screen. */
export function watchLiveStick(): void {
  if (!fs.existsSync(LIVE_FILE)) return;
  const started = Date.now();
  const check = () => {
    let verdict: string;
    try {
      verdict = fs.readFileSync(SPEED_FILE, 'utf8').split(' ')[0];
    } catch {
      if (Date.now() - started < GIVE_UP_MS) setTimeout(check, POLL_MS);
      return;
    }
    if (verdict === 'slow') {
      notifyFromSystem('slow-stick', 'Your USB stick is slow', 'DinOS will be faster once installed.');
    }
  };
  check();
}
