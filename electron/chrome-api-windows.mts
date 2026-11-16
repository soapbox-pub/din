import type { ExtensionContext } from './chrome-extensions-context.mts'
import type { ExtensionEvent } from './chrome-extensions-router.mts'
import { extensionTabUrl, visibleTab } from './chrome-extensions-permissions.mts'
import { debug } from './chrome-extensions-debug.mts'

/**
 * chrome.windows over the windows the store knows. In Din that's one: the
 * desktop, whose browser tabs are the extensions' tabs. So an extension can
 * ask about it and open new "windows" (tabs, main.mts's createWindow), but
 * not close, minimize or maximize it, which would close or hide the whole
 * desktop. Its tabs are seen as tabs.* shows them (visibleTab).
 */

const d = debug('electron-chrome-extensions:windows')

const getWindowState = (win: Electron.BaseWindow): chrome.windows.Window['state'] => {
  if (win.isMaximized()) return 'maximized'
  if (win.isMinimized()) return 'minimized'
  if (win.isFullScreen()) return 'fullscreen'
  return 'normal'
}

export class WindowsAPI {
  static WINDOW_ID_NONE = -1
  static WINDOW_ID_CURRENT = -2

  private ctx: ExtensionContext

  constructor(ctx: ExtensionContext) {
    this.ctx = ctx
    const handle = this.ctx.router.apiHandler()
    handle('windows.get', this.get.bind(this))
    handle('windows.getCurrent', this.getLastFocused.bind(this))
    handle('windows.getLastFocused', this.getLastFocused.bind(this))
    handle('windows.getAll', this.getAll.bind(this))
    handle('windows.create', this.create.bind(this))
    handle('windows.update', this.update.bind(this))
    handle('windows.remove', this.remove.bind(this))

    this.ctx.store.on('window-added', this.observeWindow.bind(this))
  }

  private observeWindow(window: Electron.BrowserWindow) {
    const windowId = window.id

    window.on('focus', () => {
      this.onFocusChanged(windowId)
    })

    window.on('resized', () => {
      this.onBoundsChanged(windowId)
    })

    window.once('closed', () => {
      this.ctx.store.windowDetailsCache.delete(windowId)
      this.ctx.store.removeWindow(window)
      this.onRemoved(windowId)
    })

    this.onCreated(windowId)

    d(`Observing window[${windowId}]`)
  }

  private createWindowDetails(win: Electron.BaseWindow) {
    const details: Partial<chrome.windows.Window> = {
      id: win.id,
      focused: win.isFocused(),
      top: win.getPosition()[1],
      left: win.getPosition()[0],
      width: win.getSize()[0],
      height: win.getSize()[1],
      tabs: Array.from(this.ctx.store.tabs)
        .filter((tab) => {
          const ownerWindow = this.ctx.store.tabToWindow.get(tab)
          return ownerWindow?.isDestroyed() ? false : ownerWindow?.id === win.id
        })
        .map((tab) => this.ctx.store.tabDetailsCache.get(tab.id) as chrome.tabs.Tab)
        .filter(Boolean),
      incognito: !this.ctx.session.isPersistent(),
      type: 'normal',
      state: getWindowState(win),
      alwaysOnTop: win.isAlwaysOnTop(),
      sessionId: 'default',
    }

    this.ctx.store.windowDetailsCache.set(win.id, details)
    return details
  }

  private getWindowDetails(win: Electron.BaseWindow) {
    return this.ctx.store.windowDetailsCache.get(win.id) ?? this.createWindowDetails(win)
  }

  /** A window's details, its tabs as this extension may see them. */
  private detailsFor(extensionId: string, details: Partial<chrome.windows.Window> | undefined) {
    if (!details) return details
    return { ...details, tabs: details.tabs?.map((tab) => visibleTab(this.ctx.permissions, extensionId, tab)) }
  }

  private getWindowFromId(id: number) {
    return id === WindowsAPI.WINDOW_ID_CURRENT ? this.ctx.store.getCurrentWindow() : this.ctx.store.getWindowById(id)
  }

  private get({ extension }: ExtensionEvent, windowId: number) {
    const win = this.getWindowFromId(windowId)
    if (!win) return { id: WindowsAPI.WINDOW_ID_NONE }
    return this.detailsFor(extension.id, this.getWindowDetails(win))
  }

  private getLastFocused({ extension }: ExtensionEvent) {
    const win = this.ctx.store.getLastFocusedWindow()
    return win ? this.detailsFor(extension.id, this.getWindowDetails(win)) : null
  }

  private getAll({ extension }: ExtensionEvent) {
    return [...this.ctx.store.windows].map((win) => this.detailsFor(extension.id, this.getWindowDetails(win)))
  }

  private async create(event: ExtensionEvent, details: chrome.windows.CreateData = {}) {
    const urls = details?.url === undefined ? [] : Array.isArray(details.url) ? details.url : [details.url]
    const url = urls.map((u) => extensionTabUrl(u, event.extension))
    const win = await this.ctx.store.createWindow(event, { url, focused: details?.focused })
    return this.detailsFor(event.extension.id, this.getWindowDetails(win))
  }

  /** The window is the desktop: nothing an extension may resize, minimize or maximize. */
  private async update({ extension }: ExtensionEvent, windowId: number) {
    const win = this.getWindowFromId(windowId)
    if (!win) return
    return this.detailsFor(extension.id, this.createWindowDetails(win))
  }

  /** Nor close: an extension's own windows are tabs, which tabs.remove closes. */
  private async remove() {
    throw new Error('The desktop’s window can’t be closed')
  }

  onCreated(windowId: number) {
    const window = this.ctx.store.getWindowById(windowId)
    if (!window) return
    const details = this.getWindowDetails(window)
    this.ctx.router.broadcastEach('windows.onCreated', (extensionId) => [this.detailsFor(extensionId, details)])
  }

  onRemoved(windowId: number) {
    this.ctx.router.broadcastEvent('windows.onRemoved', windowId)
  }

  onFocusChanged(windowId: number) {
    if (this.ctx.store.lastFocusedWindowId === windowId) return
    this.ctx.store.lastFocusedWindowId = windowId
    this.ctx.router.broadcastEvent('windows.onFocusChanged', windowId)
  }

  onBoundsChanged(windowId: number) {
    const window = this.ctx.store.getWindowById(windowId)
    if (!window) return
    const details = this.createWindowDetails(window)
    this.ctx.router.broadcastEach('windows.onBoundsChanged', (extensionId) => [this.detailsFor(extensionId, details)])
  }
}
