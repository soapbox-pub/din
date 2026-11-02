// Settings → Accessibility, for Linux apps: GTK and libadwaita apps (and Qt
// ones with the GNOME platform theme) read Reduce motion and Increase
// contrast from GSettings, as org.gnome.desktop.interface enable-animations
// and org.gnome.desktop.a11y.interface high-contrast, and follow changes as
// they happen. Din itself applies them in its own pages
// (src/lib/accessibility.ts).
//
// Only where Din is the desktop (DinOS): on GNOME the same keys are the
// user's GNOME settings, which Din leaves alone (desktop-settings.mts).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { ipcMain } from 'electron';
import { settingsOwner } from './desktop-settings.mts';
import { runCommand } from './system.mts';

/** What was last written, so an unchanged preference isn't written again. */
let applied = '';

async function gsettings(...args: string[]): Promise<void> {
  await runCommand('gsettings', args, { timeout: 3_000 });
}

export function registerAccessibilityHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  ipcMain.handle('accessibility:set', async (event, preferences: unknown) => {
    assertShellSender(event);
    const { reduceMotion, highContrast } = (preferences ?? {}) as { reduceMotion?: unknown; highContrast?: unknown };
    if (typeof reduceMotion !== 'boolean' || typeof highContrast !== 'boolean') throw new Error('Invalid accessibility preferences');
    if (settingsOwner() !== 'din') return;
    const key = `${reduceMotion}/${highContrast}`;
    if (key === applied) return;
    applied = key;
    try {
      await gsettings('set', 'org.gnome.desktop.interface', 'enable-animations', String(!reduceMotion));
      await gsettings('set', 'org.gnome.desktop.a11y.interface', 'high-contrast', String(highContrast));
    } catch (error) {
      applied = '';
      console.warn('Could not pass the accessibility settings on to native apps:', error);
    }
  });
}
