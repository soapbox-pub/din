/**
 * Right-click menus the desktop draws: a web page's, and the cut, copy and
 * paste of a text field in an app, a widget or the desktop itself. Main
 * builds the menu (electron-chrome-context-menu, extensions' items, Din's
 * own) as Electron Menus, as before, but instead of popping them up as
 * native menus, which look nothing like Din's, it sends them to the desktop
 * as data (window.dinos.menus in the preload); the desktop draws them with
 * its own menus where the page was right-clicked and says which item was
 * chosen, and main runs it here.
 */
import { ipcMain, type BrowserWindow, type Menu, type MenuItem, type WebContents } from 'electron';

/** A menu entry as the desktop draws it (src/lib/menus.ts). */
type MenuEntry =
  | { type: 'normal'; id: string; label: string; enabled: boolean; accelerator?: string }
  | { type: 'checkbox'; id: string; label: string; enabled: boolean; checked: boolean }
  | { type: 'radio'; id: string; label: string; enabled: boolean; checked: boolean; group: string }
  | { type: 'submenu'; id: string; label: string; enabled: boolean; items: MenuEntry[] }
  | { type: 'separator' };

interface Shown {
  contents: WebContents;
  items: Map<string, MenuItem>;
}

const shown = new Map<number, Shown>();
let nextToken = 1;

/** Electron's labels mark their access keys with `&`; the desktop shows none. */
function plainLabel(label: string): string {
  return label.replace(/&(.)/g, '$1');
}

const ACCELERATORS: Partial<Record<string, string>> = {
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  cut: 'Ctrl+X',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  selectall: 'Ctrl+A',
};

function entriesOf(menu: Menu, items: Map<string, MenuItem>, prefix: string): MenuEntry[] {
  const out: MenuEntry[] = [];
  menu.items.forEach((item, index) => {
    if (!item.visible) return;
    const id = `${prefix}${index}`;
    if (item.type === 'separator') {
      if (out.length > 0 && out[out.length - 1].type !== 'separator') out.push({ type: 'separator' });
      return;
    }
    const label = plainLabel(item.label);
    if (!label) return;
    items.set(id, item);
    if (item.type === 'submenu' && item.submenu) {
      out.push({ type: 'submenu', id, label, enabled: item.enabled, items: entriesOf(item.submenu, items, `${id}.`) });
    } else if (item.type === 'checkbox') {
      out.push({ type: 'checkbox', id, label, enabled: item.enabled, checked: item.checked });
    } else if (item.type === 'radio') {
      out.push({ type: 'radio', id, label, enabled: item.enabled, checked: item.checked, group: prefix || 'menu' });
    } else {
      const accelerator = item.role ? ACCELERATORS[item.role.toLowerCase()] : undefined;
      out.push({ type: 'normal', id, label, enabled: item.enabled, ...(accelerator ? { accelerator } : {}) });
    }
  });
  while (out.length > 0 && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

let shell: () => BrowserWindow | null = () => null;
let send: (channel: string, payload?: unknown) => void = () => {};

/**
 * Show `menu` for `contents`, right-clicked at (x, y) (its context-menu
 * params', which for a page are in the window it's embedded in):
 * drawn by the desktop, or as a native menu while there's no desktop to
 * draw it.
 */
export function showMenu(contents: WebContents, menu: Menu, x: number, y: number): void {
  const window = shell();
  if (!window || window.isDestroyed()) {
    menu.popup();
    return;
  }
  const items = new Map<string, MenuItem>();
  const entries = entriesOf(menu, items, '');
  if (entries.length === 0) return;
  // One menu at a time: the desktop closes the last as it opens this one.
  shown.clear();
  const token = nextToken++;
  shown.set(token, { contents, items });
  send('menus:show', { token, x, y, items: entries });
}

/** Register the menus IPC surface (window.dinos.menus in the preload). */
export function registerMenuHandlers(options: {
  assertShellSender: (event: Electron.IpcMainEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  shellWindow: () => BrowserWindow | null;
}): void {
  shell = options.shellWindow;
  send = options.sendToShell;
  ipcMain.on('menus:pick', (event, token: unknown, id: unknown) => {
    options.assertShellSender(event);
    if (typeof token !== 'number' || typeof id !== 'string') return;
    const menu = shown.get(token);
    shown.delete(token);
    const item = menu?.items.get(id);
    if (!menu || !item || menu.contents.isDestroyed()) return;
    // Back to the page first, so a role (Paste, Select All) lands in it.
    if (!menu.contents.isFocused()) menu.contents.focus();
    item.click(undefined, shell() ?? undefined, menu.contents);
  });
  ipcMain.on('menus:close', (event, token: unknown) => {
    options.assertShellSender(event);
    if (typeof token !== 'number') return;
    const menu = shown.get(token);
    shown.delete(token);
    if (menu && !menu.contents.isDestroyed() && !menu.contents.isFocused()) menu.contents.focus();
  });
}
