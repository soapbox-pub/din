import { app, ipcMain, session as electronSession } from 'electron'
import { debug } from './chrome-extensions-debug.mts'
import type { ExtensionPermissions } from './chrome-extensions-permissions.mts'

/**
 * The IPC every chrome.* call and event goes over, between the extension
 * APIs' preload (chrome-extensions-preload.cjs) and their handlers
 * (chrome-api-*.mts), plus the shell's toolbar (browser-action-preload.cjs).
 *
 * Who's calling is never taken from the call: an extension is the one whose
 * `chrome-extension://<id>` origin the calling frame has, or whose scope the
 * calling service worker has, as the browser itself reports it. (The
 * preload still sends an id, as upstream's did; it's ignored.) A handler
 * that needs a permission runs only for an extension holding it now
 * (ExtensionPermissions). The toolbar's calls (`crx-msg-remote`) are
 * answered only for the shell's own top document.
 *
 * Events go to the frame or worker that listened, and only while that frame
 * is still the extension's page.
 */

const d = debug('router')

export type IpcEvent = Electron.IpcMainEvent | Electron.IpcMainServiceWorkerEvent
export type IpcInvokeEvent = Electron.IpcMainInvokeEvent | Electron.IpcMainServiceWorkerInvokeEvent
type IpcAnyEvent = IpcEvent | IpcInvokeEvent

export type ExtensionSender = Electron.WebContents | Electron.ServiceWorkerMain

export type ExtensionEvent =
  | { type: 'frame'; sender: Electron.WebContents; frame: Electron.WebFrameMain; extension: Electron.Extension }
  | { type: 'service-worker'; sender: Electron.ServiceWorkerMain; extension: Electron.Extension }

/** The shell's call (the toolbar's): no extension. */
export interface RemoteEvent {
  type: 'remote'
  sender: Electron.WebContents
}

export type HandlerCallback = (event: ExtensionEvent, ...args: never[]) => unknown
export type RemoteCallback = (event: RemoteEvent, ...args: never[]) => unknown

export interface HandlerOptions {
  /** The API permission the extension must hold (`cookies`, `notifications`…). */
  permission?: string
}

type Handler = { remote: false; callback: HandlerCallback; permission?: string } | { remote: true; callback: RemoteCallback }

type Listener =
  | { type: 'frame'; extensionId: string; host: Electron.WebContents; frame: Electron.WebFrameMain }
  | { type: 'service-worker'; extensionId: string }

const sameListener = (a: Listener) => (b: Listener) =>
  a.extensionId === b.extensionId &&
  a.type === b.type &&
  (a.type !== 'frame' || (b.type === 'frame' && a.frame === b.frame))

/** `chrome-extension://<id>` → its id, or null for anything else. */
function extensionIdOf(origin: string | undefined): string | null {
  if (!origin) return null
  try {
    const u = new URL(origin)
    return u.protocol === 'chrome-extension:' && /^[a-p]{32}$/.test(u.host) ? u.host : null
  } catch {
    return null
  }
}

/** A frame is still an extension's own page. */
const frameOf = (frame: Electron.WebFrameMain | null | undefined, extensionId: string) =>
  !!frame && !frame.isDestroyed() && extensionIdOf(frame.origin) === extensionId

export interface RouterOptions {
  /** Whether a toolbar call comes from the shell's own top document (main.mts's shell check). */
  isShell: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean
}

export class ExtensionRouter {
  session: Electron.Session
  private permissions: ExtensionPermissions
  private isShell: RouterOptions['isShell']
  private handlers = new Map<string, Handler>()
  private listeners = new Map<string, Listener[]>()
  /** The toolbar's observers (the shell), which hear `browserAction.update`. */
  private workers = new WeakSet<Electron.ServiceWorkerMain>()

  /**
   * Background pages and workers, held so they aren't collected: the router
   * can't wake a non-persistent background to deliver an event.
   */
  private extensionHosts = new Set<Electron.WebContents>()
  private extensionWorkers = new Set<Electron.ServiceWorkerMain>()

  constructor(session: Electron.Session, permissions: ExtensionPermissions, options: RouterOptions) {
    this.session = session
    this.permissions = permissions
    this.isShell = options.isShell

    ipcMain.handle('crx-msg', this.onMessage)
    ipcMain.handle('crx-msg-remote', this.onRemoteMessage)
    ipcMain.on('crx-add-listener', this.onAddListener)
    ipcMain.on('crx-remove-listener', this.onRemoveListener)

    session.extensions.on('extension-unloaded', (_event, extension) => {
      this.filterListeners((listener) => listener.extensionId !== extension.id)
    })

    app.on('web-contents-created', (_event, webContents) => {
      if (webContents.session === this.session && webContents.getType() === 'backgroundPage') {
        d(`holding background page ${webContents.getURL()}`)
        this.extensionHosts.add(webContents)
        webContents.once('destroyed', () => this.extensionHosts.delete(webContents))
      }
    })

    // Each extension worker's own IPC: workers don't come through ipcMain.
    session.serviceWorkers.on('running-status-changed', ({ runningStatus, versionId }) => {
      if (runningStatus !== 'starting') return
      const worker = session.serviceWorkers.getWorkerFromVersionID(versionId)
      if (!worker || !extensionIdOf(worker.scope) || this.workers.has(worker)) return
      d(`listening to worker ${worker.scope}`)
      this.workers.add(worker)
      this.extensionWorkers.add(worker)
      worker.ipc.handle('crx-msg', this.onMessage)
      worker.ipc.on('crx-add-listener', this.onAddListener)
      worker.ipc.on('crx-remove-listener', this.onRemoveListener)
    })
  }

  /** The extension calling, by the sender's origin or scope, or null. */
  private callerOf(event: IpcAnyEvent): ExtensionEvent | null {
    if (event.type === 'service-worker') {
      if (event.session !== this.session) return null
      const id = extensionIdOf(event.serviceWorker.scope)
      const extension = id ? this.session.extensions.getExtension(id) : null
      return extension ? { type: 'service-worker', sender: event.serviceWorker, extension } : null
    }
    if (event.sender.session !== this.session) return null
    const frame = event.senderFrame
    const id = extensionIdOf(frame?.origin)
    const extension = id ? this.session.extensions.getExtension(id) : null
    return extension && frame ? { type: 'frame', sender: event.sender, frame, extension } : null
  }

  private onMessage = async (event: IpcInvokeEvent, _claimedId: unknown, handlerName: unknown, ...args: unknown[]) => {
    const name = String(handlerName)
    const handler = this.handlers.get(name)
    if (!handler || handler.remote) throw new Error(`${name} is not a registered handler`)
    const caller = this.callerOf(event)
    if (!caller) throw new Error(`${name} was sent from outside an extension`)
    if (handler.permission && !this.permissions.hasApi(caller.extension.id, handler.permission)) {
      throw new Error(`${name} requires the ${handler.permission} permission`)
    }
    d(`${caller.extension.id} ${name}`)
    return handler.callback(caller, ...(args as never[]))
  }

  private onRemoteMessage = async (event: Electron.IpcMainInvokeEvent, partition: unknown, handlerName: unknown, ...args: unknown[]) => {
    const name = String(handlerName)
    const handler = this.handlers.get(name)
    if (!handler || !handler.remote) throw new Error(`${name} is not a registered handler`)
    if (!this.isShell(event)) throw new Error(`${name} is only for the desktop`)
    if (typeof partition !== 'string' || electronSession.fromPartition(partition) !== this.session) {
      throw new Error(`No extensions in ${String(partition)}`)
    }
    return handler.callback({ type: 'remote', sender: event.sender }, ...(args as never[]))
  }

  private listenerOf(event: IpcEvent): Listener | null {
    const caller = this.callerOf(event)
    if (!caller) return null
    return caller.type === 'frame'
      ? { type: 'frame', extensionId: caller.extension.id, host: caller.sender, frame: caller.frame }
      : { type: 'service-worker', extensionId: caller.extension.id }
  }

  private onAddListener = (event: IpcEvent, _claimedId: unknown, eventName: unknown) => {
    const listener = this.listenerOf(event)
    if (!listener || typeof eventName !== 'string') return
    let listeners = this.listeners.get(eventName)
    if (!listeners) this.listeners.set(eventName, (listeners = []))
    if (listeners.some(sameListener(listener))) return
    d(`${listener.extensionId} listens to ${eventName}`)
    listeners.push(listener)
    if (listener.type === 'frame') {
      const { host } = listener
      host.once('destroyed', () => this.filterListeners((l) => l.type !== 'frame' || l.host !== host))
    }
  }

  private onRemoveListener = (event: IpcEvent, _claimedId: unknown, eventName: unknown) => {
    const listener = this.listenerOf(event)
    if (!listener || typeof eventName !== 'string') return
    const listeners = this.listeners.get(eventName)
    if (!listeners) return
    const index = listeners.findIndex(sameListener(listener))
    if (index >= 0) listeners.splice(index, 1)
    if (listeners.length === 0) this.listeners.delete(eventName)
  }

  private filterListeners(keep: (listener: Listener) => boolean) {
    for (const [eventName, listeners] of this.listeners) {
      const kept = listeners.filter(keep)
      if (kept.length > 0) this.listeners.set(eventName, kept)
      else this.listeners.delete(eventName)
    }
  }

  /** Answer `name` for extensions (with `permission`, where given). */
  handle(name: string, callback: HandlerCallback, opts: HandlerOptions = {}) {
    this.handlers.set(name, { remote: false, callback, permission: opts.permission })
  }

  /** Answer `name` for the shell's toolbar alone. */
  handleRemote(name: string, callback: RemoteCallback) {
    this.handlers.set(name, { remote: true, callback })
  }

  /** `handle`, bound: what each API registers its handlers with. */
  apiHandler() {
    return (name: string, callback: HandlerCallback, opts?: HandlerOptions) => this.handle(name, callback, opts)
  }

  /**
   * Send an event to the extensions listening for it: to `target` alone if
   * given, each with the arguments `argsFor` gives it (redacted to what it
   * may see), or none where that's null.
   */
  private deliver(target: string | undefined, eventName: string, argsFor: (extensionId: string) => unknown[] | null) {
    const listeners = this.listeners.get(eventName)
    if (!listeners) return
    const channel = `crx-${eventName}`
    const argsCache = new Map<string, unknown[] | null>()
    const args = (id: string) => {
      if (!argsCache.has(id)) argsCache.set(id, argsFor(id))
      return argsCache.get(id)!
    }
    for (const listener of [...listeners]) {
      const { extensionId } = listener
      if (target && target !== extensionId) continue
      const sent = args(extensionId)
      if (!sent) continue
      if (listener.type === 'service-worker') {
        this.session.serviceWorkers
          .startWorkerForScope(`chrome-extension://${extensionId}/`)
          .then((worker) => worker.send(channel, ...sent))
          .catch((error) => console.error(`Couldn't send ${eventName} to ${extensionId}`, error))
      } else if (frameOf(listener.frame, extensionId)) {
        listener.frame.send(channel, ...sent)
      } else {
        // The frame went, or went to another page.
        listeners.splice(listeners.indexOf(listener), 1)
      }
    }
  }

  /** Send an event to one extension, if it's listening. */
  sendEvent(extensionId: string, eventName: string, ...args: unknown[]) {
    this.deliver(extensionId, eventName, () => args)
  }

  /** Send an event to every extension listening, each with what `argsFor` gives it (null: none). */
  broadcastEach(eventName: string, argsFor: (extensionId: string) => unknown[] | null) {
    this.deliver(undefined, eventName, argsFor)
  }

  /** Send the same event to every extension listening: only for what anyone may see. */
  broadcastEvent(eventName: string, ...args: unknown[]) {
    this.deliver(undefined, eventName, () => args)
  }
}
