import { closeNotification, notify } from '@/lib/notificationCenter';

/**
 * The web Notification API for Din's own apps, backed by the notification
 * center. Chromium's would hand them to libnotify, which can't say which app
 * sent them or route a click back here.
 *
 * Built-in apps are trusted, so permission is always granted. Beyond the
 * standard options, `app` names the Din app sending it (its name and icon
 * head the notification), and `actions` work on `new Notification()` too, not
 * only in service workers.
 */

declare global {
  interface NotificationOptions {
    /** Din: the id of the app sending it. */
    app?: string;
    /** Buttons (standard only for service workers' showNotification). */
    actions?: { action: string; title: string }[];
  }
}

/** A notification's action button was clicked: `action` names it. */
export class NotificationActionEvent extends Event {
  readonly action: string;
  constructor(action: string) {
    super('click', { cancelable: true });
    this.action = action;
  }
}

type Handler = ((this: Notification, event: Event) => unknown) | null;

class DinNotification extends EventTarget {
  static get permission(): NotificationPermission {
    return 'granted';
  }

  static requestPermission(callback?: NotificationPermissionCallback): Promise<NotificationPermission> {
    callback?.('granted');
    return Promise.resolve('granted');
  }

  static get maxActions(): number {
    return 3;
  }

  readonly title: string;
  readonly body: string;
  readonly icon: string;
  readonly tag: string;
  readonly data: unknown;
  readonly silent: boolean | null;
  readonly requireInteraction: boolean;
  readonly dir: NotificationDirection;
  readonly lang: string;
  readonly badge: string;
  onclick: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  onshow: Handler = null;
  private readonly id: string;
  private closed = false;

  constructor(title: string, options: NotificationOptions = {}) {
    super();
    this.title = String(title);
    this.body = options.body ?? '';
    this.icon = options.icon ?? '';
    this.tag = options.tag ?? '';
    this.data = options.data ?? null;
    this.silent = options.silent ?? null;
    this.requireInteraction = options.requireInteraction ?? false;
    this.dir = options.dir ?? 'auto';
    this.lang = options.lang ?? '';
    this.badge = options.badge ?? '';

    this.id = notify({
      source: { appId: options.app, name: 'Din' },
      title: this.title,
      body: this.body,
      image: this.icon || null,
      actions: (options.actions ?? []).slice(0, 3).map((a) => ({ id: a.action, label: a.title })),
      replaceKey: this.tag ? `shell\0${this.tag}` : undefined,
      timeout: this.requireInteraction ? 0 : undefined,
      onActivate: (action) => {
        this.fire(action === 'default' ? new Event('click', { cancelable: true }) : new NotificationActionEvent(action));
      },
      onClose: () => {
        this.closed = true;
        this.fire(new Event('close'));
      },
    });
    queueMicrotask(() => this.fire(new Event('show')));
  }

  close(): void {
    if (!this.closed) closeNotification(this.id, 'closed');
  }

  private fire(event: Event): void {
    this.dispatchEvent(event);
    const handler = { click: this.onclick, close: this.onclose, error: this.onerror, show: this.onshow }[event.type];
    handler?.call(this as unknown as Notification, event);
  }
}

/** Put Din's Notification in place of Chromium's. */
export function installWebNotification(): void {
  Object.defineProperty(window, 'Notification', {
    value: DinNotification,
    writable: true,
    configurable: true,
  });
}
