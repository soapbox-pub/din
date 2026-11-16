import type { EventEmitter } from 'node:events'
import type { ExtensionPermissions } from './chrome-extensions-permissions.mts'
import type { ExtensionRouter } from './chrome-extensions-router.mts'
import type { ExtensionStore } from './chrome-extensions-store.mts'

/** Shared context for extensions in a session. */
export interface ExtensionContext {
  emit: (typeof EventEmitter)['prototype']['emit']
  router: ExtensionRouter
  session: Electron.Session
  store: ExtensionStore
  permissions: ExtensionPermissions
}

/** What the host (Din's main.mts) does for the extension APIs. */
export interface ChromeExtensionImpl {
  createTab?(
    details: chrome.tabs.CreateProperties,
  ): Promise<[Electron.WebContents, Electron.BaseWindow]>
  selectTab?(tab: Electron.WebContents, window: Electron.BaseWindow): void
  removeTab?(tab: Electron.WebContents, window: Electron.BaseWindow): void

  /**
   * Populate additional details to a tab descriptor which gets passed back to
   * background pages and content scripts.
   */
  assignTabDetails?(details: chrome.tabs.Tab, tab: Electron.WebContents): void

  createWindow?(details: chrome.windows.CreateData): Promise<Electron.BaseWindow>

  requestPermissions?(
    extension: Electron.Extension,
    permissions: chrome.permissions.Permissions,
  ): Promise<boolean>

  /**
   * Show an action's popup page anchored to its toolbar button (Din draws it
   * in the shell, ExtensionPopupHost), and take it down again.
   */
  openPopup(details: { extensionId: string; url: string; anchorRect: PopupAnchorRect }): void
  closePopup(): void
}

export interface PopupAnchorRect {
  x: number
  y: number
  width: number
  height: number
}
