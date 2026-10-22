// The date, time and time zone: the system's, which Settings → Date & Time
// shows and changes.
//
// They're systemd-timedated's, read through timedatectl, which needs no
// privileges. Changing them does: on DinOS that's os/din-time.sh, which
// DinOS's launcher names in DIN_TIME and the shell's user runs through sudo
// without a password, like the keyboard layout's helper. Elsewhere they're
// shown but not changed - the desktop's own settings do that.
//
// Chromium watches /etc/localtime, so Din's clock (and every page's Date)
// follows a new time zone without a restart.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { ipcMain } from 'electron';
import { CommandError, runCommand } from './system.mts';

const HELPER = process.env.DIN_TIME;

/** An IANA zone name, e.g. "America/New_York"; also what din-time accepts. */
const ZONE_NAME = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/;

/** A local time as timedatectl takes it. */
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

interface DateTimeStatus {
  /** IANA name of the system's time zone. */
  timeZone: string;
  /** Whether the clock is set from the network; null where that's unknown. */
  automatic: boolean | null;
  /** Whether the clock has been set from the network since it started. */
  synchronized: boolean;
  /** Whether Din can change the time zone and clock here. */
  canChange: boolean;
  /** Whether there's a network time service to turn on and off. */
  canAutomatic: boolean;
}

/** `timedatectl show`'s Key=value lines. */
async function timedated(): Promise<Map<string, string> | null> {
  try {
    const { stdout } = await runCommand('timedatectl', ['show'], { timeout: 5_000 });
    const values = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1));
    }
    return values;
  } catch {
    return null;
  }
}

async function status(): Promise<DateTimeStatus> {
  const values = await timedated();
  const zone = values?.get('Timezone');
  const canAutomatic = values?.get('CanNTP') === 'yes';
  return {
    timeZone: zone && ZONE_NAME.test(zone) ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone,
    automatic: values?.has('NTP') ? values.get('NTP') === 'yes' : null,
    synchronized: values?.get('NTPSynchronized') === 'yes',
    canChange: Boolean(HELPER) && values !== null,
    canAutomatic: Boolean(HELPER) && canAutomatic,
  };
}

let zoneList: Promise<string[]> | null = null;

/** Every time zone there is, as timedatectl knows them (or, failing that, ICU). */
function timeZones(): Promise<string[]> {
  zoneList ??= (async () => {
    try {
      const { stdout } = await runCommand('timedatectl', ['list-timezones', '--no-pager'], { timeout: 5_000 });
      const zones = stdout.split('\n').map((line) => line.trim()).filter((zone) => ZONE_NAME.test(zone));
      if (zones.length > 0) return zones;
    } catch {
      // fall back to ICU's
    }
    return Intl.supportedValuesOf('timeZone');
  })();
  return zoneList;
}

async function helper(args: string[]): Promise<void> {
  if (!HELPER) throw new Error('Din can\'t change the date and time on this system');
  try {
    await runCommand('sudo', ['-n', HELPER, ...args], { timeout: 15_000 });
  } catch (error) {
    // The helper says what went wrong on its last line.
    const reason = error instanceof CommandError ? error.stderr.trim().split('\n').pop() : '';
    throw reason ? new Error(reason) : error;
  }
}

export function registerDateTimeHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  ipcMain.handle('datetime:status', async (event) => {
    assertShellSender(event);
    return status();
  });

  ipcMain.handle('datetime:zones', async (event) => {
    assertShellSender(event);
    return timeZones();
  });

  ipcMain.handle('datetime:set-zone', async (event, zone: unknown) => {
    assertShellSender(event);
    if (typeof zone !== 'string' || !ZONE_NAME.test(zone) || !(await timeZones()).includes(zone)) {
      throw new Error('Unknown time zone');
    }
    await helper(['zone', zone]);
  });

  ipcMain.handle('datetime:set-automatic', async (event, automatic: unknown) => {
    assertShellSender(event);
    if (typeof automatic !== 'boolean') throw new Error('automatic must be a boolean');
    await helper(['automatic', automatic ? 'on' : 'off']);
  });

  ipcMain.handle('datetime:set-time', async (event, time: unknown) => {
    assertShellSender(event);
    if (typeof time !== 'string' || !LOCAL_TIME.test(time)) throw new Error('Not a time');
    await helper(['set', time]);
  });
}
