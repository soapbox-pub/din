import { Menu, MenuItem, nativeImage } from 'electron'
import type { ExtensionContext } from './chrome-extensions-context.mts'
import type { ExtensionEvent, RemoteEvent } from './chrome-extensions-router.mts'
import {
  getExtensionUrl,
  getExtensionManifest,
  getIconPath,
  resolveExtensionPath,
  matchSize,
  ResizeType,
} from './chrome-extensions-common.mts'
import { extensionTabUrl, visibleTab } from './chrome-extensions-permissions.mts'
import { debug } from './chrome-extensions-debug.mts'

/**
 * chrome.action (MV3) and chrome.browserAction (MV2), both browserAction.*
 * here: each extension's toolbar button (title, icon, badge, popup), per tab
 * or for all of them, and the shell's toolbar (browser-action-preload.cjs),
 * which asks for them all and reports clicks.
 *
 * A click opens the extension's popup, which must be one of its own pages
 * (the shell draws it beside the button, as if it were the browser's own),
 * or tells the extension it was clicked; either gives it activeTab.
 */

const d = debug('browserAction')

interface ExtensionAction {
  color?: string
  text?: string
  title?: string
  icon?: chrome.browserAction.TabIconDetails
  popup?: string
  /** Last modified date for icon. */
  iconModified?: number
}

type ExtensionActionKey = keyof ExtensionAction

interface ActivateDetails {
  eventType: string
  extensionId: string
  tabId: number
  anchorRect: { x: number; y: number; width: number; height: number }
}

interface ExtensionActionStore extends ExtensionAction {
  tabs: Record<string, ExtensionAction>
}

const getBrowserActionDefaults = (extension: Electron.Extension): ExtensionAction | undefined => {
  const manifest = getExtensionManifest(extension)
  const browserAction =
    manifest.manifest_version === 3 ? manifest.action : manifest.manifest_version === 2 ? manifest.browser_action : undefined
  if (typeof browserAction !== 'object') return undefined
  const action: ExtensionAction = { title: browserAction.default_title || manifest.name }
  const iconPath = getIconPath(extension)
  if (iconPath) action.icon = { path: iconPath }
  if (browserAction.default_popup) action.popup = browserAction.default_popup
  return action
}

/** A badge colour as CSS: a string as given, or Chrome's [r, g, b, a]. */
function badgeColor(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, 64)
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number')) {
    const [r, g, b, a] = value as number[]
    return `rgba(${r}, ${g}, ${b}, ${a / 255})`
  }
  return undefined
}

/** A value an extension sets, kept only if it's what that property holds. */
function clean(prop: ExtensionActionKey, value: unknown): unknown {
  switch (prop) {
    case 'color':
      return badgeColor(value)
    case 'text':
    case 'title':
    case 'popup':
      return typeof value === 'string' ? value.slice(0, prop === 'text' ? 16 : 1024) : undefined
    default:
      return value
  }
}

export class BrowserActionAPI {
  private actionMap = new Map</* extensionId */ string, ExtensionActionStore>()
  /** The extension whose popup is open, so a second click closes it. */
  private popupExtensionId?: string
  private observers = new Set<Electron.WebContents>()
  private queuedUpdate = false
  private ctx: ExtensionContext

  constructor(ctx: ExtensionContext) {
    this.ctx = ctx
    const handle = this.ctx.router.apiHandler()

    const getter =
      (prop: ExtensionActionKey) =>
      ({ extension }: ExtensionEvent, details: chrome.browserAction.TabDetails = {}) => {
        const action = this.getAction(extension.id)
        const tabId = details?.tabId
        return (tabId && action.tabs[tabId] ? action.tabs[tabId][prop] : undefined) ?? action[prop]
      }

    const setter =
      (prop: ExtensionActionKey) =>
      (event: ExtensionEvent, details: Record<string, unknown> = {}) =>
        this.setDetails(event, typeof details?.tabId === 'number' ? details.tabId : undefined, prop, details?.[prop])

    for (const [name, key] of [
      ['BadgeBackgroundColor', 'color'],
      ['BadgeText', 'text'],
      ['Title', 'title'],
      ['Popup', 'popup'],
    ] as const) {
      handle(`browserAction.get${name}`, getter(key))
      handle(`browserAction.set${name}`, setter(key))
    }

    // Pinning isn't a choice here: every button is on the toolbar.
    handle('browserAction.getUserSettings', (): chrome.action.UserSettings => ({ isOnToolbar: true }))

    // setIcon takes a path, paths by size, or image data (data: URLs, from the preload).
    handle('browserAction.setIcon', (event, details: chrome.browserAction.TabIconDetails = {}) => {
      const { tabId, ...icon } = details ?? {}
      const tab = typeof tabId === 'number' ? tabId : undefined
      this.setDetails(event, tab, 'icon', icon)
      this.setDetails(event, tab, 'iconModified', Date.now())
    })

    handle('browserAction.openPopup', this.openPopup)

    // The shell's toolbar.
    const { router } = this.ctx
    router.handleRemote('browserAction.getState', () => this.getState())
    router.handleRemote('browserAction.activate', (event: RemoteEvent, details: ActivateDetails) => this.activate(event, details))
    router.handleRemote('browserAction.addObserver', ({ sender }: RemoteEvent) => {
      this.observers.add(sender)
      sender.once('destroyed', () => this.observers.delete(sender))
    })
    router.handleRemote('browserAction.removeObserver', ({ sender }: RemoteEvent) => {
      this.observers.delete(sender)
    })

    this.ctx.store.on('active-tab-changed', () => this.onUpdate())

    // A tab's own settings go with it.
    this.ctx.store.on('tab-removed', (tabId: number) => {
      for (const action of this.actionMap.values()) delete action.tabs[tabId]
      this.onUpdate()
    })

    ctx.session.extensions.on('extension-loaded', (_event, extension) => this.processExtension(extension))
    ctx.session.extensions.on('extension-unloaded', (_event, extension) => this.removeActions(extension.id))
  }

  private setDetails({ extension }: ExtensionEvent, tabId: number | undefined, prop: ExtensionActionKey, raw: unknown) {
    let value = clean(prop, raw)
    // Unset is the manifest's.
    if (value === undefined || value === null) value = getBrowserActionDefaults(extension)?.[prop]
    const action = this.getAction(extension.id)
    const target = tabId ? (action.tabs[tabId] ??= {}) : action
    Object.assign(target, { [prop]: value })
    this.onUpdate()
  }

  /** crx://extension-icon/<extension id>/<size>/<resize>?tabId=…: an action's icon, as PNG. */
  handleCRXRequest(request: GlobalRequest): GlobalResponse {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'extension-icon') return new Response(null, { status: 400 })

      const tabId = url.searchParams.get('tabId')
      const [, extensionId, size, resize] = url.pathname.split('/')
      const imageSize = parseInt(size, 10)
      const resizeType = (parseInt(resize, 10) || ResizeType.Up) as ResizeType
      const extension = this.ctx.session.extensions.getExtension(extensionId)
      const action = this.actionMap.get(extensionId)
      const iconDetails = action ? (tabId && action.tabs[tabId]?.icon) || action.icon : undefined

      let iconImage: Electron.NativeImage | undefined
      if (extension && iconDetails) {
        const imagePath =
          typeof iconDetails.path === 'string'
            ? iconDetails.path
            : typeof iconDetails.path === 'object'
              ? matchSize(iconDetails.path, imageSize, resizeType)
              : undefined
        const iconAbsPath = imagePath && resolveExtensionPath(extension, imagePath)
        if (iconAbsPath) {
          iconImage = nativeImage.createFromPath(iconAbsPath)
        } else if (typeof iconDetails.imageData === 'string') {
          iconImage = nativeImage.createFromDataURL(iconDetails.imageData)
        } else if (typeof iconDetails.imageData === 'object') {
          const imageData = matchSize(iconDetails.imageData as unknown as Record<number, string>, imageSize, resizeType)
          iconImage = imageData ? nativeImage.createFromDataURL(imageData) : undefined
        }
      }

      if (!iconImage || iconImage.isEmpty()) return new Response(null, { status: 400 })
      return new Response(new Uint8Array(iconImage.toPNG()), { status: 200, headers: { 'Content-Type': 'image/png' } })
    } catch (error) {
      console.error(error)
      return new Response(null, { status: 500 })
    }
  }

  private getAction(extensionId: string) {
    let action = this.actionMap.get(extensionId)
    if (!action) {
      action = { tabs: {} }
      this.actionMap.set(extensionId, action)
      this.onUpdate()
    }
    return action
  }

  private removeActions(extensionId: string) {
    this.actionMap.delete(extensionId)
    this.onUpdate()
  }

  /**
   * The popup page for a tab, or none. Only the extension's own pages: one
   * pointed at a web page would sit beside the button as if it were the
   * extension's, or the browser's.
   */
  private getPopupUrl(extensionId: string, tabId: number) {
    const action = this.getAction(extensionId)
    const popupPath = action.tabs[tabId]?.popup ?? action.popup
    if (!popupPath) return undefined
    try {
      const url = new URL(popupPath, `chrome-extension://${extensionId}/`)
      return url.protocol === 'chrome-extension:' && url.host === extensionId ? url.href : undefined
    } catch {
      return undefined
    }
  }

  private processExtension(extension: Electron.Extension) {
    const defaultAction = getBrowserActionDefaults(extension)
    if (defaultAction) Object.assign(this.getAction(extension.id), defaultAction)
  }

  /** Every action, without its icon (the toolbar loads those over crx:). */
  private getState() {
    const actions = [...this.actionMap].map(([id, { icon: _icon, tabs, ...rest }]) => ({
      id,
      tabs: Object.fromEntries(Object.entries(tabs).map(([tabId, { icon: _tabIcon, ...tab }]) => [tabId, tab])),
      ...rest,
    }))
    const activeTab = this.ctx.store.getActiveTabOfCurrentWindow()
    return { activeTabId: activeTab?.id, actions }
  }

  private activate(_event: RemoteEvent, details: ActivateDetails) {
    if (!details || typeof details.extensionId !== 'string') return
    d(`activate ${details.eventType} ${details.extensionId} on tab ${details.tabId}`)
    if (!this.ctx.session.extensions.getExtension(details.extensionId)) return
    switch (details.eventType) {
      case 'click':
        this.activateClick(details)
        break
      case 'contextmenu':
        this.activateContextMenu(details)
        break
    }
  }

  private activateClick(details: ActivateDetails) {
    const { extensionId, tabId, anchorRect } = details

    // A second click on the same action closes its popup.
    if (this.popupExtensionId) {
      const same = this.popupExtensionId === extensionId
      this.popupExtensionId = undefined
      this.ctx.store.impl.closePopup()
      if (same) return
    }

    const tab = tabId >= 0 ? this.ctx.store.getTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) throw new Error('Unable to get active tab')

    // The user chose the extension for this page.
    this.ctx.permissions.grantActiveTab(extensionId, tab.id)

    const popupUrl = this.getPopupUrl(extensionId, tab.id)
    if (popupUrl) {
      this.popupExtensionId = extensionId
      this.ctx.store.impl.openPopup({ extensionId, url: popupUrl, anchorRect })
      d(`opened popup: ${popupUrl}`)
    } else {
      this.ctx.router.sendEvent(
        extensionId,
        'browserAction.onClicked',
        visibleTab(this.ctx.permissions, extensionId, this.ctx.store.tabDetailsCache.get(tab.id)),
      )
    }
  }

  /** The shell's action popup closed (dismissed, or its page closed itself). */
  popupClosed() {
    this.popupExtensionId = undefined
  }

  private activateContextMenu(details: ActivateDetails) {
    const { extensionId, anchorRect } = details
    const extension = this.ctx.session.extensions.getExtension(extensionId)
    if (!extension) throw new Error(`Unregistered extension '${extensionId}'`)

    const manifest = getExtensionManifest(extension)
    const menu = new Menu()
    const append = (opts: Electron.MenuItemConstructorOptions) => menu.append(new MenuItem(opts))
    const appendSeparator = () => menu.append(new MenuItem({ type: 'separator' }))
    const open = (url: string | undefined) => {
      try {
        void this.ctx.store.createTab({ url: extensionTabUrl(url, extension), active: true })
      } catch (error) {
        console.error(error)
      }
    }

    append({
      label: extension.name,
      click: () => open(manifest.homepage_url || `https://chromewebstore.google.com/detail/${extension.id}`),
    })
    appendSeparator()

    const contextMenuItems = this.ctx.store.buildMenuItems(extensionId, 'browser_action')
    if (contextMenuItems.length > 0) {
      for (const item of contextMenuItems) menu.append(item)
      appendSeparator()
    }

    const optionsPage = manifest.options_page || manifest.options_ui?.page
    const optionsPageUrl = optionsPage ? getExtensionUrl(extension, optionsPage) : undefined
    append({ label: 'Options', enabled: typeof optionsPageUrl === 'string', click: () => open(optionsPageUrl) })

    menu.popup({ x: Math.floor(anchorRect.x), y: Math.floor(anchorRect.y + anchorRect.height) })
  }

  /** chrome.action.openPopup: its popup, over the current window's active tab. */
  private openPopup = (event: ExtensionEvent, options?: chrome.action.OpenPopupOptions) => {
    const window =
      typeof options?.windowId === 'number' ? this.ctx.store.getWindowById(options.windowId) : this.ctx.store.getCurrentWindow()
    if (!window || window.isDestroyed()) return
    const activeTab = this.ctx.store.getActiveTabFromWindow(window)
    if (!activeTab) return
    const popupUrl = this.getPopupUrl(event.extension.id, activeTab.id)
    if (!popupUrl) return
    // With no button to anchor to, the window's top right, as Chrome does.
    const [width] = window.getSize()
    const anchorSize = 64
    if (this.popupExtensionId) this.ctx.store.impl.closePopup()
    this.popupExtensionId = event.extension.id
    this.ctx.store.impl.openPopup({
      extensionId: event.extension.id,
      url: popupUrl,
      anchorRect: { x: width - anchorSize, y: 0, width: anchorSize, height: anchorSize },
    })
  }

  private onUpdate() {
    if (this.queuedUpdate) return
    this.queuedUpdate = true
    queueMicrotask(() => {
      this.queuedUpdate = false
      for (const observer of this.observers) {
        if (!observer.isDestroyed()) observer.send('browserAction.update')
      }
    })
  }
}
