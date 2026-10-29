// Tells systemd's watchdog the main process is alive, so a hang restarts Din
// instead of freezing the whole computer.
//
// Din is the desktop: when this process's main thread stops (Chromium's
// find-in-page looping forever did it, electron/electron#54199), no window
// draws or takes input, and Ctrl+Alt+F2 is the only way out. On DinOS,
// os/configuration.nix gives din-shell's unit a WatchdogSec; systemd passes it down
// as WATCHDOG_USEC, and this pings from the main thread's event loop at half
// that. A stuck loop stops the pings, and systemd restarts din-shell and Din.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { dinFd } from './native-gpu.mts';

// Read once and taken out of the environment: everything Din starts (the
// Terminal's shells, native apps) is in the same unit, and with
// NotifyAccess=all a stray "WATCHDOG=1" or "READY=1" from one of them would
// count as Din's.
const socket = process.env.NOTIFY_SOCKET;
const usec = Number(process.env.WATCHDOG_USEC);
delete process.env.NOTIFY_SOCKET;
delete process.env.WATCHDOG_USEC;
delete process.env.WATCHDOG_PID;

/** Start pinging the watchdog, when the service has one. */
export function startWatchdog(): void {
  if (!socket || !(usec > 0)) return;
  const addon = dinFd();
  if (!addon) {
    console.error('watchdog: din-fd is missing, so the watchdog will restart Din');
    return;
  }
  const ping = () => {
    try {
      addon.notify(socket, 'WATCHDOG=1');
    } catch (error) {
      console.error('watchdog:', error);
    }
  };
  ping();
  setInterval(ping, usec / 1000 / 2);
}
