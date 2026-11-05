// The networks the computer is on, as NetworkManager's active Wi-Fi and wired
// connections, by UUID (so two networks that share a name aren't confused).
// What's remembered for a network (AirPlay receivers, printers) is kept under
// these.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { runCommand } from './system.mts';

const TIMEOUT_MS = 15_000;

/** The active connections' UUIDs, sorted; none without NetworkManager. */
export async function activeNetworks(): Promise<string[]> {
  try {
    const { stdout } = await runCommand('nmcli', ['-t', '-f', 'UUID,TYPE,STATE', 'connection', 'show', '--active'], {
      timeout: TIMEOUT_MS,
    });
    return stdout
      .split('\n')
      .map((line) => line.split(':'))
      .filter(([uuid, type, active]) => uuid && /^802-(11-wireless|3-ethernet)$/.test(type) && active === 'activated')
      .map(([uuid]) => uuid)
      .sort();
  } catch {
    return [];
  }
}
