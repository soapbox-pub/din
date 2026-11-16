import { randomUUID } from 'node:crypto'
import type { ExtensionContext } from './chrome-extensions-context.mts'
import type { ExtensionEvent } from './chrome-extensions-router.mts'
import { getExtensionUrl, getExtensionManifest } from './chrome-extensions-common.mts'
import { NativeMessagingHost, type NativeMessagingPeer } from './chrome-native-messaging.mts'

/**
 * chrome.runtime's part Electron lacks: native messaging (for extensions
 * with `nativeMessaging`, to the hosts installed for Chrome that list them in
 * allowed_origins, as the extension the browser says is calling) and
 * openOptionsPage.
 */

/** The frame or worker that called, which hears the port's messages. */
const peerOf = (event: ExtensionEvent): NativeMessagingPeer => (event.type === 'frame' ? event.frame : event.sender)

export class RuntimeAPI {
  /** Open ports, by extension and then connection id. */
  private hosts = new Map<string, Map<string, NativeMessagingHost>>()
  private ctx: ExtensionContext

  constructor(ctx: ExtensionContext) {
    this.ctx = ctx
    const handle = this.ctx.router.apiHandler()
    const permission = { permission: 'nativeMessaging' }
    handle('runtime.connectNative', this.connectNative, permission)
    handle('runtime.disconnectNative', this.disconnectNative, permission)
    handle('runtime.openOptionsPage', this.openOptionsPage)
    handle('runtime.sendNativeMessage', this.sendNativeMessage, permission)

    ctx.session.extensions.on('extension-unloaded', (_event, extension) => {
      for (const host of this.hosts.get(extension.id)?.values() ?? []) host.destroy()
      this.hosts.delete(extension.id)
    })
  }

  private connectNative = async (event: ExtensionEvent, connectionId: unknown, application: unknown) => {
    if (typeof connectionId !== 'string' || !/^[\w-]{1,64}$/.test(connectionId) || typeof application !== 'string') {
      throw new Error('Invalid native messaging connection')
    }
    const id = event.extension.id
    let ports = this.hosts.get(id)
    if (!ports) this.hosts.set(id, (ports = new Map()))
    ports.get(connectionId)?.destroy()
    ports.set(connectionId, new NativeMessagingHost(id, peerOf(event), connectionId, application))
  }

  private disconnectNative = (event: ExtensionEvent, connectionId: unknown) => {
    const ports = this.hosts.get(event.extension.id)
    if (typeof connectionId !== 'string' || !ports) return
    ports.get(connectionId)?.destroy()
    ports.delete(connectionId)
  }

  private sendNativeMessage = async (event: ExtensionEvent, application: unknown, message: unknown) => {
    if (typeof application !== 'string') throw new Error('Invalid native messaging host')
    const host = new NativeMessagingHost(event.extension.id, peerOf(event), randomUUID(), application, false)
    await host.ready
    return await host.sendAndReceive(message)
  }

  private openOptionsPage = async ({ extension }: ExtensionEvent) => {
    const manifest = getExtensionManifest(extension)
    // An embedded options page (options_ui without open_in_new_tab) opens in a tab too.
    const page = manifest.options_ui?.page ?? manifest.options_page
    const url = page ? getExtensionUrl(extension, page) : undefined
    if (url?.startsWith(`chrome-extension://${extension.id}/`)) await this.ctx.store.createTab({ url, active: true })
  }
}
