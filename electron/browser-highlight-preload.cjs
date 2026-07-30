// @ts-check
// Preload for the ad-hoc Web Browser's <webview> tabs (the WebBrowser surface).
//
// Brings Ditto's NIP-84 "Highlight" affordance to arbitrary websites: when the
// user selects text on any page, a small floating "Highlight" button appears;
// clicking it publishes a kind 9802 Highlight event referencing the page URL
// (an `r`-tag source, per NIP-84's website-highlight form).
//
// Unlike Ditto, the highlighted content is a foreign web page, not Din's own
// rendered Nostr content - so there are no `data-highlight-*` attributes to
// resolve a source event from. The source is instead the tab's own URL, which
// the MAIN PROCESS reads authoritatively from the guest's WebContents (never
// this script's report), so a hostile page can't forge a highlight for a URL
// it isn't actually serving.
//
// Signing uses the "native signer in the environment": the click is proxied
// over IPC (din-highlight:publish) to the main process, which relays it to the
// Din shell, where the signed-in account's signer runs (see HighlightBridgeHost
// and the din-highlight:* handlers in main.mts). No keys, no window.nostr, and
// no signer surface are ever exposed to the page:
//
//   - This preload runs in an isolated world; the page's own JavaScript cannot
//     see `ipcRenderer` or any function here.
//   - The button lives in a CLOSED shadow root, so page scripts can't find or
//     restyle it, and only a genuine user gesture (event.isTrusted) publishes -
//     a synthetic `.click()` is ignored.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { ipcRenderer } = require('electron');

// --- Tunables (mirrors Ditto's useTextHighlight / HighlightSelectionButton) --

/** Longest selection we treat as a highlight (guards "Select All" of an article). */
const MAX_HIGHLIGHT_LENGTH = 5000;
/** Longest surrounding context we attach. */
const MAX_CONTEXT_LENGTH = 8000;
/** How long the selection must stay stable before the button appears (ms). */
const SELECTION_DEBOUNCE_MS = 350;
/** Gap (px) between the selection and the floating button. */
const BUTTON_OFFSET = 8;
/** Approximate button box, used to keep it on-screen. */
const BUTTON_WIDTH = 96;
const BUTTON_HEIGHT = 32;
/** Block-level tags that delimit a "paragraph" for context extraction. */
const BLOCK_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'TD', 'FIGCAPTION']);

// --- Selection helpers ------------------------------------------------------

/**
 * Normalize line endings and trim, but preserve internal linebreaks.
 * @param {string} value
 * @returns {string}
 */
function normalizeText(value) {
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * A context string is usable if it contains the highlight verbatim, differs
 * from it, and fits the cap.
 * @param {string} context
 * @param {string} text
 * @returns {boolean}
 */
function isUsableContext(context, text) {
  return !!context && context.length <= MAX_CONTEXT_LENGTH && context !== text && context.includes(text);
}

/**
 * Extract the paragraph surrounding the selection to use as the NIP-84
 * `context`: the nearest block-level ancestor, else the blank-line-delimited
 * paragraph of the common-ancestor text that contains the highlight. Returns
 * undefined when nothing suitable is found.
 * @param {Range} range
 * @param {string} text
 */
function extractContext(range, text) {
  let block =
    range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  while (block) {
    if (BLOCK_TAGS.has(block.tagName)) {
      const para = normalizeText(block.textContent || '');
      if (isUsableContext(para, text)) return para;
      break;
    }
    block = block.parentElement;
  }

  const rootEl =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  const full = normalizeText(rootEl ? rootEl.textContent || '' : '');
  if (full.includes(text)) {
    const para = full.split(/\n{2,}/).find((/** @type {string} */ p) => p.includes(text));
    if (para && isUsableContext(para.trim(), text)) return para.trim();
    if (isUsableContext(full, text)) return full;
  }
  return undefined;
}

/**
 * Resolve the current selection to a highlightable payload, or null when there
 * is no usable selection (collapsed, empty, too long, or inside an editable
 * field where highlighting makes no sense).
 * @returns {{ text: string, context: string | undefined, rect: DOMRect } | null}
 */
function readSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const text = normalizeText(sel.toString());
  if (!text || text.length > MAX_HIGHLIGHT_LENGTH) return null;

  const range = sel.getRangeAt(0);
  const anchorEl =
    range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  if (anchorEl && anchorEl.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) {
    return null;
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  return { text, context: extractContext(range, text), rect };
}

// --- Floating button UI (closed shadow root, isolated from the page) --------

/** @typedef {{ text: string, context: string | undefined, rect: DOMRect }} HighlightSelection */

/** @type {HTMLElement | null} */ let host = null;
/** @type {ShadowRoot | null} */ let shadow = null;
/** @type {HTMLButtonElement | null} */ let button = null;
/** @type {HTMLElement | null} */ let toast = null;
/** The selection snapshot the button currently offers to publish.
 * @type {HighlightSelection | null} */
let current = null;
let publishing = false;

/** Build the button + toast inside a closed shadow root on first use. */
function ensureUi() {
  if (host) return;
  const parent = document.body || document.documentElement;
  if (!parent) return;

  host = document.createElement('div');
  host.setAttribute('data-din-highlight', '');
  // Take the host out of layout entirely; children position themselves fixed.
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
  shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .btn {
      position: fixed;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff;
      background: #7c3aed;
      border: none;
      border-radius: 9999px;
      padding: 8px 14px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,0.28);
      opacity: 0;
      transform: translateY(2px);
      transition: opacity .12s ease, transform .12s ease, background .12s ease;
      pointer-events: none;
    }
    .btn.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
    .btn:hover { background: #6d28d9; }
    .btn:disabled { opacity: .6; cursor: default; }
    .btn svg { width: 15px; height: 15px; }
    .toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%) translateY(8px);
      font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff;
      background: rgba(24,24,27,0.96);
      border-radius: 10px;
      padding: 10px 16px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.35);
      opacity: 0;
      transition: opacity .16s ease, transform .16s ease;
      pointer-events: none;
      max-width: 80vw;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .toast.err { background: rgba(153,27,27,0.96); }
  `;
  shadow.appendChild(style);

  button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg><span>Highlight</span>';
  // mousedown fires before the selection is torn down by the focus change, and
  // isTrusted rejects synthetic page-driven clicks.
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    if (event.isTrusted) publish();
  });
  shadow.appendChild(button);

  toast = document.createElement('div');
  toast.className = 'toast';
  shadow.appendChild(toast);

  parent.appendChild(host);
}

/**
 * Position + reveal the button above the current selection rect.
 * @param {DOMRect} rect
 */
function showButton(rect) {
  ensureUi();
  if (!button) return;
  const fullyAbove = rect.bottom <= 0;
  const fullyBelow = rect.top >= window.innerHeight;
  if (fullyAbove || fullyBelow) {
    hideButton();
    return;
  }
  const top = Math.max(BUTTON_OFFSET, rect.top - BUTTON_HEIGHT - BUTTON_OFFSET);
  const rawLeft = rect.left + rect.width / 2 - BUTTON_WIDTH / 2;
  const left = Math.min(
    Math.max(BUTTON_OFFSET, rawLeft),
    window.innerWidth - BUTTON_WIDTH - BUTTON_OFFSET,
  );
  button.style.top = `${top}px`;
  button.style.left = `${left}px`;
  button.classList.add('show');
}

function hideButton() {
  if (button) button.classList.remove('show');
}

/** @type {ReturnType<typeof setTimeout> | null} */
let toastTimer = null;
/**
 * Flash a transient message in the shadow-root toast.
 * @param {string} message
 * @param {boolean} isError
 */
function showToast(message, isError) {
  ensureUi();
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('err', !!isError);
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast && toast.classList.remove('show'), 3200);
}

// --- Publish flow -----------------------------------------------------------

async function publish() {
  if (publishing || !current) return;
  const snapshot = current;
  publishing = true;
  if (button) {
    button.disabled = true;
    const label = button.querySelector('span');
    if (label) label.textContent = 'Publishing…';
  }
  try {
    await ipcRenderer.invoke('din-highlight:publish', {
      text: snapshot.text,
      context: snapshot.context,
    });
    showToast('Highlight published', false);
    window.getSelection()?.removeAllRanges();
    current = null;
    hideButton();
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'Failed to publish highlight';
    // Electron prefixes invoke errors with the handler location; keep it short.
    const message = raw.replace(/^Error: /, '').split('Error invoking remote method')[0].trim();
    showToast(message || 'Failed to publish highlight', true);
  } finally {
    publishing = false;
    if (button) {
      button.disabled = false;
      const label = button.querySelector('span');
      if (label) label.textContent = 'Highlight';
    }
  }
}

// --- Selection tracking -----------------------------------------------------

/** @type {number | null} */
let frame = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let debounceTimer = null;

function compute() {
  const selection = readSelection();
  if (!selection) {
    current = null;
    hideButton();
    return;
  }
  current = selection;
  showButton(selection.rect);
}

function schedule() {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    frame = null;
    compute();
  });
}

function onSelectionChange() {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString().trim()) {
    if (frame !== null) cancelAnimationFrame(frame);
    current = null;
    hideButton();
    return;
  }
  debounceTimer = setTimeout(schedule, SELECTION_DEBOUNCE_MS);
}

// The guest enables nodeIntegrationInSubFrames (so the extension chrome.* API
// preload reaches inline-autofill overlay iframes), which also loads this
// preload in every sub-frame. The highlight affordance is a top-document
// concern, so stay inert in iframes rather than attaching duplicate selection
// listeners or floating buttons inside embedded frames and ads.
if (window.top === window.self) {
  document.addEventListener('selectionchange', onSelectionChange);
  // Reposition immediately (no debounce) so a shown button tracks the selection.
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
}
