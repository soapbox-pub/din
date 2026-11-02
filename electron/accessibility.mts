// Settings → Accessibility, for what Din doesn't draw itself.
//
// Web pages and apps: every <webview> guest sees Reduce motion, Reduce
// transparency and Increase contrast as the CSS media features
// prefers-reduced-motion: reduce, prefers-reduced-transparency: reduce and
// prefers-contrast: more, in stylesheets and matchMedia alike, as a browser
// shows the system's settings. Chromium reads none of them from Linux, so
// they're set on each guest through the DevTools protocol
// (Emulation.setEmulatedMedia), whose debugger is held only while one is on
// (guest-debugger.mts). Din's own pages apply them too (src/lib/accessibility.ts).
//
// Linux apps: GTK and libadwaita apps (and Qt ones with the GNOME platform
// theme) read Reduce motion and Increase contrast from GSettings, as
// org.gnome.desktop.interface enable-animations and
// org.gnome.desktop.a11y.interface high-contrast, and follow changes as they
// happen. Only where Din is the desktop (DinOS): on GNOME the same keys are
// the user's GNOME settings, which Din leaves alone (desktop-settings.mts).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { app, ipcMain, webContents } from 'electron';
import { settingsOwner } from './desktop-settings.mts';
import { holdDebugger, holdsDebugger, releaseDebugger } from './guest-debugger.mts';
import { runCommand } from './system.mts';

const HOLDER = 'media-features';

/** What was last written, so an unchanged preference isn't written again. */
let applied = '';

/** The media features guests get; an empty value is the page's own default. */
let features: { name: string; value: string }[] = [];

async function gsettings(...args: string[]): Promise<void> {
  await runCommand('gsettings', args, { timeout: 3_000 });
}

function applyMediaFeatures(contents: Electron.WebContents): void {
  if (contents.isDestroyed() || contents.getType() !== 'webview') return;
  const send = () => contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features }).catch(() => {});
  if (features.some((f) => f.value)) {
    if (holdDebugger(contents, HOLDER, () => applyMediaFeatures(contents))) void send();
  } else if (holdsDebugger(contents, HOLDER)) {
    // Cleared for whoever else holds it; let go, which detaches it if nobody does.
    void send().finally(() => releaseDebugger(contents, HOLDER));
  }
}

export function registerAccessibilityHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  // Every new document (a guest's first, a reload, a crash's recovery) gets them.
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument && features.some((f) => f.value)) applyMediaFeatures(contents);
    });
  });

  ipcMain.handle('accessibility:set', async (event, preferences: unknown) => {
    assertShellSender(event);
    const { reduceMotion, reduceTransparency = false, highContrast } = (preferences ?? {}) as {
      reduceMotion?: unknown;
      reduceTransparency?: unknown;
      highContrast?: unknown;
    };
    if (typeof reduceMotion !== 'boolean' || typeof reduceTransparency !== 'boolean' || typeof highContrast !== 'boolean') {
      throw new Error('Invalid accessibility preferences');
    }

    const next = [
      { name: 'prefers-reduced-motion', value: reduceMotion ? 'reduce' : '' },
      // As on Din's own pages, Increase contrast makes surfaces solid too.
      { name: 'prefers-reduced-transparency', value: reduceTransparency || highContrast ? 'reduce' : '' },
      { name: 'prefers-contrast', value: highContrast ? 'more' : '' },
    ];
    if (JSON.stringify(next) !== JSON.stringify(features)) {
      features = next;
      for (const contents of webContents.getAllWebContents()) applyMediaFeatures(contents);
    }

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
