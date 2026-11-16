// @ts-check
// The Web Browser's extension buttons: <browser-action-list partition="…">,
// a custom element for the desktop (WebBrowser.tsx's BrowserActionList),
// with a <button is="browser-action"> for each extension's action, its icon
// served at crx://extension-icon/… and its title and badge kept current.
// Clicking one asks main (chrome-api-action.mts) to open its popup, which the
// desktop draws (ExtensionPopupHost), or tell the extension it was clicked.
// Registered on the desktop's session by main.mts.
//
// Adapted from electron-chrome-extensions (MIT, Samuel Maddock; see
// chrome-extensions.mts).
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { ipcRenderer, contextBridge } = require('electron');

/**
 * @typedef {{ title?: string, text?: string, color?: string, popup?: string, iconModified?: number }} ActionInfo
 * @typedef {ActionInfo & { id: string, tabs: Record<string, ActionInfo> }} Action
 * @typedef {{ activeTabId?: number, actions: Action[] }} ActionState
 * @typedef {{
 *   eventType: string,
 *   extensionId: string,
 *   tabId: number,
 *   anchorRect: { x: number, y: number, width: number, height: number },
 *   alignment?: string,
 * }} ActivateDetails
 */

/** @type {Map<string, Action>} */
const actions = new Map();
/** @type {Map<string, number>} */
const observerCounts = new Map();
/** @type {Set<(state: ActionState) => void>} */
const updateListeners = new Set();

/**
 * @param {string} name
 * @param {string} partition
 * @param {unknown[]} args
 */
const invoke = (name, partition, ...args) => ipcRenderer.invoke('crx-msg-remote', partition, name, ...args);

const browserAction = {
  /** @param {'update'} _name @param {(state: ActionState) => void} listener */
  addEventListener(_name, listener) {
    updateListeners.add(listener);
  },
  /** @param {'update'} _name @param {(state: ActionState) => void} listener */
  removeEventListener(_name, listener) {
    updateListeners.delete(listener);
  },
  /** @param {string} extensionId */
  getAction(extensionId) {
    return actions.get(extensionId);
  },
  /** @param {string} partition @returns {Promise<ActionState>} */
  async getState(partition) {
    const state = /** @type {ActionState} */ (await invoke('browserAction.getState', partition));
    for (const action of state.actions) actions.set(action.id, action);
    queueMicrotask(() => {
      for (const listener of [...updateListeners]) listener(state);
    });
    return state;
  },
  /** @param {string} partition @param {ActivateDetails} details */
  activate(partition, details) {
    return invoke('browserAction.activate', partition, details);
  },
  /** @param {string} partition */
  addObserver(partition) {
    const count = (observerCounts.get(partition) ?? 0) + 1;
    observerCounts.set(partition, count);
    if (count === 1) void invoke('browserAction.addObserver', partition);
  },
  /** @param {string} partition */
  removeObserver(partition) {
    const count = Math.max((observerCounts.get(partition) ?? 0) - 1, 0);
    if (count > 0) {
      observerCounts.set(partition, count);
      return;
    }
    observerCounts.delete(partition);
    void invoke('browserAction.removeObserver', partition);
  },
};

ipcRenderer.on('browserAction.update', () => {
  for (const partition of observerCounts.keys()) void browserAction.getState(partition);
});

/**
 * Runs in the page's own world, which owns its custom elements registry, so
 * it must be self-contained: it reaches main through `globalThis.browserAction`.
 */
function mainWorldScript() {
  const DEFAULT_PARTITION = '_self';
  const api = /** @type {typeof browserAction} */ (/** @type {{ browserAction?: unknown }} */ (globalThis).browserAction);

  /** @param {HTMLElement} el @param {string} name */
  const intAttribute = (el, name) => {
    const value = parseInt(el.getAttribute(name) || '', 10);
    return isNaN(value) ? null : value;
  };

  class BrowserActionElement extends HTMLButtonElement {
    /** @type {number | undefined} */
    updateId;
    /** @type {HTMLDivElement | undefined} */
    badge;
    /** @type {HTMLImageElement | undefined} */
    pendingIcon;

    get tab() {
      return intAttribute(this, 'tab') ?? -1;
    }
    set tab(tab) {
      this.setAttribute('tab', `${tab}`);
    }
    get partition() {
      return this.getAttribute('partition');
    }
    set partition(partition) {
      if (partition) this.setAttribute('partition', partition);
      else this.removeAttribute('partition');
    }
    get alignment() {
      return this.getAttribute('alignment') || '';
    }
    set alignment(alignment) {
      this.setAttribute('alignment', alignment);
    }

    static get observedAttributes() {
      return ['id', 'tab', 'partition', 'alignment'];
    }

    constructor() {
      super();
      this.addEventListener('click', (event) => this.activate(event));
      this.addEventListener('contextmenu', (event) => {
        event.stopImmediatePropagation();
        event.preventDefault();
        this.activate(event);
      });
    }

    connectedCallback() {
      if (this.isConnected) this.update();
    }

    disconnectedCallback() {
      if (this.updateId) {
        cancelAnimationFrame(this.updateId);
        this.updateId = undefined;
      }
      this.pendingIcon = undefined;
    }

    attributeChangedCallback() {
      if (this.isConnected) this.update();
    }

    /** @param {Event} event */
    activate(event) {
      const rect = this.getBoundingClientRect();
      void api.activate(this.partition || DEFAULT_PARTITION, {
        eventType: event.type,
        extensionId: this.id,
        tabId: this.tab,
        alignment: this.alignment,
        anchorRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      });
    }

    getBadge() {
      if (!this.badge) {
        this.badge = document.createElement('div');
        this.badge.className = 'badge';
        this.badge.setAttribute('part', 'badge');
        this.appendChild(this.badge);
      }
      return this.badge;
    }

    update() {
      if (this.updateId) return;
      this.updateId = requestAnimationFrame(() => this.render());
    }

    /** @param {ActionInfo} info */
    updateIcon(info) {
      const search = new URLSearchParams({ tabId: `${this.tab}`, partition: `${this.partition || DEFAULT_PARTITION}` });
      if (info.iconModified) search.append('t', `${info.iconModified}`);
      const iconUrl = `crx://extension-icon/${this.id}/32/2?${search}`;

      if (this.pendingIcon) {
        this.pendingIcon.onload = this.pendingIcon.onerror = null;
        this.pendingIcon = undefined;
      }

      // Loaded first, so the old icon stays until the new one can replace it.
      const img = (this.pendingIcon = new Image());
      img.onerror = () => {
        if (!this.isConnected) return;
        this.classList.toggle('no-icon', true);
        if (this.title) this.dataset.letter = this.title.charAt(0);
        this.pendingIcon = undefined;
      };
      img.onload = () => {
        if (!this.isConnected) return;
        this.classList.toggle('no-icon', false);
        this.style.backgroundImage = `url(${iconUrl})`;
        this.pendingIcon = undefined;
      };
      img.src = iconUrl;
    }

    render() {
      this.updateId = undefined;
      const action = api.getAction(this.id);
      if (!action) return;
      const tabInfo = this.tab > -1 ? action.tabs[this.tab] : {};
      const info = { ...tabInfo, ...action };

      this.title = typeof info.title === 'string' ? info.title : '';
      this.updateIcon(info);

      if (info.text) {
        const badge = this.getBadge();
        badge.textContent = info.text;
        badge.style.color = '#fff';
        badge.style.backgroundColor = info.color ?? '';
      } else if (this.badge) {
        this.badge.remove();
        this.badge = undefined;
      }
    }
  }

  customElements.define('browser-action', BrowserActionElement, { extends: 'button' });

  class BrowserActionListElement extends HTMLElement {
    observing = false;

    get tab() {
      return intAttribute(this, 'tab');
    }
    get partition() {
      return this.getAttribute('partition');
    }
    get alignment() {
      return this.getAttribute('alignment') || '';
    }

    static get observedAttributes() {
      return ['tab', 'partition', 'alignment'];
    }

    constructor() {
      super();
      const shadowRoot = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
:host {
  display: flex;
  flex-direction: row;
  gap: 5px;
}

.action {
  width: 28px;
  height: 28px;
  background-color: transparent;
  background-position: center;
  background-repeat: no-repeat;
  background-size: 70%;
  border: none;
  border-radius: 4px;
  padding: 0;
  position: relative;
  outline: none;
}

.action:hover {
  background-color: var(--browser-action-hover-bg, rgba(255, 255, 255, 0.3));
}

.action.no-icon::after {
  content: attr(data-letter);
  text-transform: uppercase;
  font-size: .7rem;
  background-color: #757575;
  color: white;
  border-radius: 4px;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 80%;
  height: 80%;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
}

.badge {
  box-shadow: 0px 0px 1px 1px var(--browser-action-badge-outline, #444);
  box-sizing: border-box;
  max-width: 100%;
  height: 12px;
  padding: 0 2px;
  border-radius: 2px;
  position: absolute;
  bottom: 1px;
  right: 0;
  pointer-events: none;
  line-height: 1.5;
  font-size: 9px;
  font-weight: 400;
  overflow: hidden;
  white-space: nowrap;
}`;
      shadowRoot.appendChild(style);
    }

    connectedCallback() {
      if (!this.isConnected) return;
      this.startObserving();
      void this.fetchState();
    }

    disconnectedCallback() {
      this.stopObserving();
    }

    /** @param {string} _name @param {string | null} oldValue @param {string | null} newValue */
    attributeChangedCallback(_name, oldValue, newValue) {
      if (oldValue !== newValue && this.isConnected) void this.fetchState();
    }

    startObserving() {
      if (this.observing) return;
      api.addEventListener('update', this.renderState);
      api.addObserver(this.partition || DEFAULT_PARTITION);
      this.observing = true;
    }

    stopObserving() {
      if (!this.observing) return;
      api.removeEventListener('update', this.renderState);
      api.removeObserver(this.partition || DEFAULT_PARTITION);
      this.observing = false;
    }

    async fetchState() {
      try {
        await api.getState(this.partition || DEFAULT_PARTITION);
      } catch {
        console.error(`browser-action-list failed to update [tab: ${this.tab}, partition: '${this.partition}']`);
      }
    }

    /** @param {ActionState} state */
    renderState = (state) => {
      const root = /** @type {ShadowRoot} */ (this.shadowRoot);
      const tabId = typeof this.tab === 'number' && this.tab >= 0 ? this.tab : state.activeTabId || -1;

      for (const action of state.actions) {
        let node = /** @type {BrowserActionElement | null} */ (root.querySelector(`[id="${CSS.escape(action.id)}"]`));
        if (!node) {
          node = /** @type {BrowserActionElement} */ (document.createElement('button', { is: 'browser-action' }));
          node.id = action.id;
          node.className = 'action';
          node.alignment = this.alignment;
          node.setAttribute('part', 'action');
          root.appendChild(node);
        }
        if (this.partition) node.partition = this.partition;
        if (this.alignment) node.alignment = this.alignment;
        node.tab = tabId;
      }

      // Take away what's no longer there.
      for (const node of /** @type {NodeListOf<BrowserActionElement>} */ (root.querySelectorAll('.action'))) {
        if (!state.actions.some((action) => action.id === node.id)) node.remove();
      }
    };
  }

  customElements.define('browser-action-list', BrowserActionListElement);
}

// The desktop's own document, not a frame in it (main answers only that).
if (process.isMainFrame && process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('browserAction', browserAction);
    // The main world's own custom elements registry.
    contextBridge.executeInMainWorld({ func: mainWorldScript });
  } catch (error) {
    console.error('<browser-action-list> failed to load', error);
  }
}
