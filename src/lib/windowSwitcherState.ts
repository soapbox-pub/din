/**
 * Tiny shared flag for "an Alt+Tab window switch is in progress", kept in its
 * own module so both the WindowSwitcher (which owns the gesture) and
 * DesktopHotkeys (which stands down while it runs) can touch it without a
 * component importing a non-component export from the other.
 */
let active = false;

/** Mark the window switcher as open or closed. */
export function setWindowSwitcherActive(value: boolean): void {
  active = value;
}

/** Whether an Alt+Tab window switch is currently open. */
export function isWindowSwitcherActive(): boolean {
  return active;
}
