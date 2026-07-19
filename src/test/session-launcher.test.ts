import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Repo-invariant smoke check for the standalone login session
 * (`os/x11/din-session.sh` + `os/x11/din.desktop`).
 *
 * That path runs the *production* Electron shell with no DIN_DEV_URL and is
 * exercised by neither `npm test`'s build nor the Nix/Aladdin image, so it can
 * silently drift when `electron/main.cjs`, the app layout, or the two session
 * files change. These assertions pin the couplings the launcher relies on.
 */

// Repo root: vitest runs with the project root as cwd (npm test invokes it
// from there). jsdom's import.meta.url isn't a file:// URL, so cwd is the
// reliable anchor.
const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const main = read('electron/main.cjs');
const script = read('os/x11/din-session.sh');
const desktop = read('os/x11/din.desktop');

describe('standalone Din session launcher', () => {
  it('keeps main.cjs opening a fullscreen kiosk when DIN_DEV_URL is unset', () => {
    // The launcher deliberately sets no DIN_DEV_URL; main.cjs must still key
    // the fullscreen kiosk off its absence, or the session opens windowed.
    expect(main).toMatch(/DEV_URL\s*=\s*process\.env\.DIN_DEV_URL/);
    expect(main).toMatch(/production\s*=\s*!DEV_URL/);
    expect(main).toMatch(/fullscreen:\s*production/);
    expect(main).toMatch(/kiosk:\s*production/);
  });

  it('execs paths that actually exist in the tree', () => {
    // The files the launcher runs must live where it looks for them.
    expect(() => statSync(join(root, 'electron/main.cjs'))).not.toThrow();
    expect(script).toContain('node_modules/.bin/electron');
    expect(script).toContain('electron/main.cjs');
    expect(script).toContain('dist/index.html');
    // It must never *set* DIN_DEV_URL (that flips main.cjs to dev/windowed).
    expect(script).not.toMatch(/^\s*(export\s+)?DIN_DEV_URL=/m);
  });

  it('is an executable shell script the display manager can run directly', () => {
    expect(script.startsWith('#!')).toBe(true);
    expect(statSync(join(root, 'os/x11/din-session.sh')).mode & 0o111).toBeGreaterThan(0);
  });

  it('registers a session whose Exec matches the documented install symlink', () => {
    const exec = desktop.match(/^Exec=(.+)$/m)?.[1].trim();
    expect(exec).toBe('/usr/local/bin/din-session');
    // The script's own install instructions must create exactly that symlink.
    expect(script).toContain('/usr/local/bin/din-session');
    expect(desktop).toContain('[Desktop Entry]');
    expect(desktop).toMatch(/^Type=Application$/m);
    expect(desktop).toMatch(/^Name=Din$/m);
  });
});
