/**
 * Settings' windows for what's more than a quick question (under Settings in
 * the Dock): adding a printer, and connecting an app to the account. One
 * window each; opening it again starts it over (`at`).
 */
export const ADD_PRINTER_APP_ID = 'add-printer';
export const CONNECT_APP_APP_ID = 'connect-app';

/** Add a Printer's launch params. */
export function addPrinterParams(): Record<string, unknown> {
  return { at: Date.now() };
}

/** Connect an App's launch params: `link`, a nostrconnect:// link to show the app it's for, or none to make one. */
export function connectAppParams(link = ''): Record<string, unknown> {
  return { link, at: Date.now() };
}

/**
 * The App Store's Add an App from a Folder…: the desktop's window, since
 * adding one allows what it asks for. `{ path }` is the folder chosen.
 */
export const FOLDER_APP_WINDOW_ID = 'add-folder-app';
