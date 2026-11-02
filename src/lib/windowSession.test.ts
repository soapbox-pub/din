import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSession,
  expectNativeWindows,
  readSession,
  saveWindowState,
  snapshotSession,
  takeNativePlacement,
  writeSession,
  type LiveSession,
} from './windowSession';

type LiveWindow = LiveSession['windows'][number];

function win(id: string, appId: string, extra: Partial<LiveWindow> = {}): LiveWindow {
  return {
    id, appId, x: 10, y: 20, width: 800, height: 600, z: 1,
    minimized: false, closing: false, maximized: false, snapped: null, split: null, monitor: null,
    restore: null, frameless: false, floating: false, workspace: 1, ...extra,
  };
}

const live = (windows: LiveWindow[]): LiveSession => ({ windows, trees: { '1@m': { leaf: 'win-1' } }, active: { m: 2 } });

describe('window session', () => {
  beforeEach(() => {
    localStorage.clear();
    clearSession();
  });

  it('saves windows bottom to top, without closing or one-off ones', () => {
    const session = snapshotSession(
      live([win('win-1', 'files', { z: 9 }), win('win-2', 'paint', { z: 3 }), win('win-3', 'notes', { closing: true }), win('win-4', 'devtools')]),
      () => false,
    );
    expect(session.windows.map((w) => [w.appId, w.z])).toEqual([['paint', 1], ['files', 2]]);
    expect(session.trees).toEqual({ '1@m': { leaf: 'win-1' } });
    expect(session.active).toEqual({ m: 2 });
  });

  it('keeps launch params that last, and drops the rest', () => {
    const [w] = snapshotSession(
      live([win('win-1', 'files', { params: { path: '/home', shortcut: 'new', adoptTab: 't', fn: () => {} } })]),
      () => false,
    ).windows;
    expect(w.params).toEqual({ path: '/home' });
  });

  it('keeps native windows only of apps it can start again', () => {
    const session = snapshotSession(
      live([win('win-1', 'firefox', { params: { xid: 5, width: 1, height: 1 } }), win('win-2', 'mystery', { params: { xid: 6 } })]),
      (id) => id === 'firefox',
    );
    expect(session.windows.map((w) => [w.appId, w.native, w.params])).toEqual([['firefox', true, {}]]);
  });

  it('carries what a window saved, and forgets it once the window is gone', () => {
    expect(saveWindowState('win-1', { tabs: [1, 2] })).toBe(true);
    expect(snapshotSession(live([win('win-1', 'terminal')]), () => false).windows[0].state).toEqual({ tabs: [1, 2] });
    snapshotSession(live([]), () => false);
    expect(snapshotSession(live([win('win-1', 'terminal')]), () => false).windows[0].state).toBeUndefined();
  });

  it('refuses state too big to keep', () => {
    expect(saveWindowState('win-1', 'x'.repeat(600 * 1024))).toBe(false);
  });

  it('reads back what it wrote, and nothing unreadable', () => {
    const session = snapshotSession(live([win('win-1', 'files')]), () => false);
    writeSession(session);
    expect(readSession()).toEqual(session);
    localStorage.setItem('din:session:windows', '{"windows": 3}');
    expect(readSession()).toBeNull();
  });

  it('places native windows in the order they were', () => {
    const [a, b] = snapshotSession(
      live([win('win-1', 'gimp', { params: { xid: 1 }, z: 1, x: 1 }), win('win-2', 'gimp', { params: { xid: 2 }, z: 2, x: 2 })]),
      () => true,
    ).windows;
    expectNativeWindows('gimp', [a, b]);
    expect(takeNativePlacement('gimp')?.x).toBe(1);
    expect(takeNativePlacement('gimp')?.x).toBe(2);
    expect(takeNativePlacement('gimp')).toBeNull();
  });
});
