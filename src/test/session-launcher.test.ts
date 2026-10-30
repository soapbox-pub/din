import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Repo-invariant smoke check for Din's login session on other Linuxes
 * (`scripts/session.mjs`).
 *
 * Its builds run the *production* Electron shell with no DIN_DEV_URL, laid
 * out the way DinOS's are, under Din's compositor, and neither `npm test`'s
 * build nor the Nix/DinOS image exercises them, so they can silently drift
 * when `electron/` or the compositor change. These assertions pin the
 * couplings the script relies on.
 */

// Repo root: vitest runs with the project root as cwd (npm test invokes it
// from there). jsdom's import.meta.url isn't a file:// URL, so cwd is the
// reliable anchor.
const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const main = read('electron/main.mts');
const script = read('scripts/session.mjs');

describe('login session builds', () => {
  it('keeps main.mts opening a fullscreen kiosk when DIN_DEV_URL is unset', () => {
    expect(main).toMatch(/DEV_URL\s*=\s*process\.env\.DIN_DEV_URL/);
    expect(main).toMatch(/production\s*=\s*!DEV_URL/);
    expect(main).toMatch(/if \(fullscreen\) \{\s*win\.setFullScreen\(true\);\s*win\.setKiosk\(true\);/);
    expect(script).not.toMatch(/DIN_DEV_URL=/);
  });

  it('lays a build out where Electron main looks', () => {
    // app/main.mjs with dist/ beside it, and os/din-askpass.py one up.
    expect(main).toContain("path.join(import.meta.dirname, 'dist')");
    expect(script).toContain('path.join(app, "dist")');
    expect(read('electron/system-packages.mts')).toContain("'../os/din-askpass.py'");
    expect(existsSync(join(root, 'os/din-askpass.py'))).toBe(true);
    expect(script).toContain('"os/din-askpass.py"');
  });

  it('points Electron at the compositor and din-fd it ships', () => {
    expect(read('electron/native-display.mts')).toContain('process.env.DIN_COMPOSITOR');
    expect(read('electron/native-gpu.mts')).toContain('process.env.DIN_FD_ADDON');
    expect(script).toContain('export DIN_COMPOSITOR="$here/bin/din-compositor"');
    expect(script).toContain('export DIN_FD_ADDON="$here/lib/libdin_fd.so"');
    expect(read('native/din-compositor/src/session/mod.rs')).toContain('usage: din-compositor session -- PROGRAM');
    expect(script).toContain('din-compositor" session -- "$here/din"');
  });

  it('tells Electron main it is the whole desktop, and which build it is', () => {
    expect(read('electron/desktop-settings.mts')).toContain("process.env.DIN_DESKTOP_SESSION === '1'");
    expect(script).toContain('export DIN_DESKTOP_SESSION=1');
    expect(read('electron/login-session.mts')).toContain('process.env.DIN_SESSION_RELEASE');
    expect(script).toContain('export DIN_SESSION_RELEASE=');
  });

  it('registers a session whose Exec is the wrapper it installs', () => {
    expect(script).toContain('const WRAPPER = "/usr/local/bin/din-session"');
    expect(script).toMatch(/^Exec=\$\{WRAPPER\}$/m);
    expect(script).toContain('const DESKTOP_FILE = "/usr/share/wayland-sessions/din.desktop"');
  });
});
