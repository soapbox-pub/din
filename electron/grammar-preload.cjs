// @ts-check
// Session preload that checks grammar as you type, in every frame of the
// desktop, built-in apps, widgets and web pages (see electron/grammar.mts).
//
// When a text field the page lets Chromium spell-check gets the cursor, and
// again a moment after typing stops, its text goes to main, which checks it
// on this computer and says where the problems are. Each one gets a blue
// wavy underline, the way spelling's red ones look, and nothing else: no
// badge, no popup. Right-clicking one tells main which issue is under the
// pointer as the menu opens, so the menu can lead with its fixes; picking
// one comes back here, and is typed in as the user would have (undo undoes
// it).
//
// Underlines in a rich editor (contenteditable) are a CSS highlight over the
// text itself. A text area's or text box's text can't be reached that way,
// so each gets a mirror: a copy of its text laid out the same way, invisible
// but for the underlines, kept over it as it scrolls and moves. The mirror
// is in a closed shadow root and never takes the pointer.
//
// Fields that turn spell checking off (spellcheck="false": addresses, code,
// names), code editors and terminals, and anything inside
// data-din-grammar="off" aren't checked.
//
// Stays in the isolated world: the page can't see or call any of this.
//
// Registered with session.registerPreloadScript in main.mts, so it runs in
// every frame, each on its own.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { ipcRenderer, webFrame } = require('electron');

/**
 * @typedef {{ start: number, end: number, text: string, hash: string }} Mark
 * @typedef {{ node: Text, start: number, len: number }} Segment
 * @typedef {{ text: string, segs: Segment[] }} Reading
 * @typedef {{ host: HTMLElement, box: HTMLElement, line: HTMLElement, spans: { span: HTMLElement, mark: Mark }[] }} Mirror
 * @typedef {{
 *   el: HTMLElement,
 *   rich: boolean,
 *   text: string,
 *   marks: Mark[],
 *   ranges: { range: Range, mark: Mark }[],
 *   mirror: Mirror | null,
 *   timer: ReturnType<typeof setTimeout> | null,
 *   seq: number,
 * }} Field
 */

/** How long after typing stops a field is checked. */
const TYPING_DELAY_MS = 700;
/** How long after a field gets the cursor it's checked. */
const FOCUS_DELAY_MS = 150;
/** Longer than this, a field isn't checked (main's limit too). */
const MAX_TEXT = 60_000;
/** Fields whose underlines are kept after the cursor leaves them. */
const MAX_FIELDS = 12;
/** The underline's color: blue, beside spelling's red. */
const COLOR = '#2f7bf5';
const HIGHLIGHT = 'din-grammar';

/** Elements that start a new line of text in a rich editor. */
const BLOCKS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
  'SECTION', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL',
]);
/** Elements in a rich editor whose text isn't prose. */
const SKIPPED = new Set([
  'SCRIPT', 'STYLE', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON', 'SVG',
  'MATH', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'VIDEO', 'AUDIO', 'CANVAS', 'IMG',
]);
/** Editors that aren't for prose, and anything that opts out. */
const OPTED_OUT = '[data-din-grammar="off"], .cm-editor, .CodeMirror, .monaco-editor, .ace_editor, .xterm';

/** What a mirror copies from its field, so its text lays out the same. */
const COPIED = /** @type {const} */ ([
  'direction', 'fontFamily', 'fontSize', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch',
  'fontFeatureSettings', 'fontVariationSettings', 'fontKerning', 'fontOpticalSizing', 'letterSpacing',
  'wordSpacing', 'lineHeight', 'textTransform', 'textIndent', 'textAlign', 'tabSize', 'textRendering',
  'wordBreak', 'overflowWrap', 'hyphens', 'paddingTop', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRadius',
]);

/** @type {Map<HTMLElement, Field>} */
const fields = new Map();
/** The issue the last right-click was on, for a fix picked from its menu. */
/** @type {{ token: number, field: Field, mark: Mark } | null} */
let lastContext = null;
let nextToken = 1;
/** @type {Highlight | null} */
let highlight = null;
/** @type {CSSStyleSheet | null} */
let mirrorSheet = null;
let syncQueued = false;
/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;
/** @type {ResizeObserver | null} */
let resizeObserver = null;

// ---------------------------------------------------------------------------
// Which fields
// ---------------------------------------------------------------------------

/** @param {Element} el */
function isTextControl(el) {
  return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /** @type {HTMLInputElement} */ (el).type === 'text');
}

/**
 * The field an event happened in, if it's one to check: a text area, a text
 * box, or a rich editor's editing host.
 * @param {EventTarget | null} target
 * @returns {{ el: HTMLElement, rich: boolean } | null}
 */
function fieldOf(target) {
  if (!target || !(target instanceof HTMLElement)) return null;
  /** @type {HTMLElement | null} */
  let el = null;
  let rich = false;
  if (isTextControl(target)) {
    const control = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (target);
    if (control.readOnly || control.disabled) return null;
    el = control;
  } else if (target.isContentEditable) {
    el = target;
    while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
    rich = true;
  }
  if (!el || !el.spellcheck || el.closest(OPTED_OUT)) return null;
  return { el, rich };
}

/** @param {Event} event */
function eventTarget(event) {
  return event.composedPath()[0] ?? event.target;
}

// ---------------------------------------------------------------------------
// Reading a field
// ---------------------------------------------------------------------------

/**
 * A rich editor's text as prose: its text nodes in order, with a line break
 * for each <br> and a blank line between blocks, so sentences in different
 * paragraphs aren't read as one. Non-breaking spaces read as spaces.
 * @param {HTMLElement} host
 * @returns {Reading}
 */
function readRich(host) {
  let text = '';
  /** @type {Segment[]} */
  const segs = [];
  const breakLine = () => {
    if (text && !text.endsWith('\n\n')) text += text.endsWith('\n') ? '\n' : '\n\n';
  };
  /** @param {Node} node */
  const walk = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        const data = /** @type {Text} */ (child).data;
        if (!data) continue;
        segs.push({ node: /** @type {Text} */ (child), start: text.length, len: data.length });
        text += data.replace(/\u00a0/g, ' ');
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = /** @type {Element} */ (child);
        const tag = el.tagName.toUpperCase();
        if (tag === 'BR') {
          text += '\n';
        } else if (SKIPPED.has(tag) || el.getAttribute('contenteditable') === 'false') {
          text += ' ';
        } else if (BLOCKS.has(tag)) {
          breakLine();
          walk(el);
          breakLine();
        } else {
          walk(el);
        }
      }
    }
  };
  walk(host);
  return { text, segs };
}

/** @param {Field} field @returns {Reading} */
function read(field) {
  if (field.rich) return readRich(field.el);
  return { text: /** @type {HTMLInputElement} */ (field.el).value, segs: [] };
}

/**
 * Where an offset into a rich editor's text is in its nodes, or null if
 * it's in a break this added.
 * @param {Segment[]} segs
 * @param {number} offset
 * @param {boolean} end the end of a range, which may sit just past a node's text
 * @returns {[Text, number] | null}
 */
function locate(segs, offset, end) {
  let lo = 0;
  let hi = segs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (end ? segs[mid].start < offset : segs[mid].start <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const seg = segs[found];
  const local = offset - seg.start;
  if (end ? local > seg.len : local >= seg.len) return null;
  return [seg.node, local];
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

/** @param {HTMLElement} el @param {boolean} rich @returns {Field} */
function track(el, rich) {
  let field = fields.get(el);
  if (field) {
    // Most recently used last, so the oldest is the one let go.
    fields.delete(el);
    fields.set(el, field);
    return field;
  }
  field = { el, rich, text: '', marks: [], ranges: [], mirror: null, timer: null, seq: 0 };
  fields.set(el, field);
  for (const other of [...fields.values()]) {
    if (!other.el.isConnected) forget(other);
  }
  while (fields.size > MAX_FIELDS) {
    const oldest = fields.values().next().value;
    if (!oldest || oldest === field) break;
    forget(oldest);
  }
  return field;
}

/** @param {Field} field */
function forget(field) {
  if (field.timer) clearTimeout(field.timer);
  clearMarks(field);
  fields.delete(field.el);
  resizeObserver?.unobserve(field.el);
}

/** @param {Field} field @param {number} delay */
function schedule(field, delay) {
  if (field.timer) clearTimeout(field.timer);
  field.timer = setTimeout(() => {
    field.timer = null;
    void check(field);
  }, delay);
}

/** @param {Field} field */
async function check(field) {
  if (!field.el.isConnected) {
    forget(field);
    return;
  }
  const before = read(field);
  const seq = ++field.seq;
  if (before.text.length > MAX_TEXT || !before.text.trim()) {
    show(field, [], before);
    return;
  }
  /** @type {Mark[] | null} */
  let marks;
  try {
    marks = await ipcRenderer.invoke('grammar:check', before.text);
  } catch {
    return;
  }
  if (seq !== field.seq || !field.el.isConnected) return;
  if (marks === null) {
    // Turned off: take every underline away.
    for (const other of [...fields.values()]) forget(other);
    return;
  }
  const after = read(field);
  // Typed into while it was being checked: the next check is on its way.
  if (after.text !== before.text) return;
  show(field, marks.filter((mark) => !misspelled(mark.text)), after);
}

/**
 * Whether Chromium underlines a word of this text as misspelled. An issue
 * that touches one isn't shown: two underlines on one word, red and blue,
 * just say the same thing twice (Harper calls "dinphone" a typo for "din
 * phone", and its sentence lowercase, where Chromium already says it's no
 * word), and the issue comes back once the spelling is fixed.
 * @param {string} text
 */
function misspelled(text) {
  for (const [word] of text.matchAll(/[\p{L}\p{M}][\p{L}\p{M}'’]*/gu)) {
    if (webFrame.isWordMisspelled(word)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Underlines
// ---------------------------------------------------------------------------

/** @param {Field} field */
function clearMarks(field) {
  for (const { range } of field.ranges) highlight?.delete(range);
  field.ranges = [];
  field.marks = [];
  if (field.mirror) {
    field.mirror.host.remove();
    field.mirror = null;
    updatePolling();
  }
}

/** @param {Field} field @param {Mark[]} marks @param {Reading} reading */
function show(field, marks, reading) {
  clearMarks(field);
  field.text = reading.text;
  field.marks = marks;
  if (!marks.length) return;
  if (field.rich) showRich(field, reading);
  else showMirror(field);
}

/** @returns {Highlight | null} */
function grammarHighlight() {
  if (highlight) return highlight;
  if (typeof Highlight !== 'function' || !CSS.highlights) return null;
  webFrame.insertCSS(
    `::highlight(${HIGHLIGHT}) { text-decoration: underline wavy ${COLOR}; text-decoration-skip-ink: none; }`,
  );
  highlight = new Highlight();
  CSS.highlights.set(HIGHLIGHT, highlight);
  return highlight;
}

/** @param {Field} field @param {Reading} reading */
function showRich(field, reading) {
  const hl = grammarHighlight();
  if (!hl) return;
  for (const mark of field.marks) {
    const start = locate(reading.segs, mark.start, false);
    const end = locate(reading.segs, mark.end, true);
    if (!start || !end) continue;
    const range = new Range();
    range.setStart(start[0], start[1]);
    range.setEnd(end[0], end[1]);
    field.ranges.push({ range, mark });
    hl.add(range);
  }
}

/**
 * Typing changed a rich editor: its underlines' ranges moved with the text,
 * and any whose words were typed into go until the next check.
 * @param {Field} field
 */
function editedRich(field) {
  field.ranges = field.ranges.filter(({ range, mark }) => {
    const still = range.toString().replace(/\u00a0/g, ' ') === mark.text;
    if (!still) highlight?.delete(range);
    return still;
  });
  field.marks = field.ranges.map(({ mark }) => mark);
}

/**
 * Typing changed a text area: underlines before the change stay, those
 * after it move with the text, and those it touched go until the next check.
 * @param {Field} field
 */
function editedText(field) {
  const old = field.text;
  const now = /** @type {HTMLInputElement} */ (field.el).value;
  if (old === now) return;
  const max = Math.min(old.length, now.length);
  let prefix = 0;
  while (prefix < max && old[prefix] === now[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && old[old.length - 1 - suffix] === now[now.length - 1 - suffix]) suffix++;
  const oldEnd = old.length - suffix;
  const delta = now.length - old.length;
  const marks = field.marks
    .filter((m) => m.end <= prefix || m.start >= oldEnd)
    .map((m) => (m.start >= oldEnd ? { ...m, start: m.start + delta, end: m.end + delta } : m));
  field.text = now;
  field.marks = marks;
  if (marks.length) showMirror(field);
  else clearMarks(field);
}

// ---------------------------------------------------------------------------
// Mirrors, for text areas and text boxes
// ---------------------------------------------------------------------------

function sheet() {
  if (mirrorSheet) return mirrorSheet;
  mirrorSheet = new CSSStyleSheet();
  mirrorSheet.replaceSync(`
    .box {
      position: fixed; box-sizing: border-box; margin: 0; overflow: hidden;
      border-style: solid; border-color: transparent; background: none;
      color: transparent; -webkit-text-fill-color: transparent;
      pointer-events: none; user-select: none; contain: layout paint;
    }
    .box.single { display: flex; align-items: center; white-space: pre; }
    .line { flex: none; }
    .u { text-decoration: underline wavy ${COLOR}; text-decoration-skip-ink: none; }
  `);
  return mirrorSheet;
}

/**
 * Where a field's mirror goes: the page, or the modal dialog or popover
 * it's in, which sit in the top layer above everything else.
 * @param {HTMLElement} el
 */
function containerOf(el) {
  const top = el.closest('dialog, [popover]');
  if (top && (top.matches(':modal') || top.matches(':popover-open'))) return top;
  return document.documentElement;
}

/** @param {Field} field @returns {Mirror} */
function createMirror(field) {
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;overflow:visible;margin:0;padding:0;border:0;' +
    'pointer-events:none;z-index:2147483647;display:block;';
  const root = host.attachShadow({ mode: 'closed' });
  root.adoptedStyleSheets = [sheet()];
  const box = document.createElement('div');
  box.className = 'box';
  const line = document.createElement('div');
  line.className = 'line';
  box.append(line);
  root.append(box);
  containerOf(field.el).append(host);
  resizeObserver ??= new ResizeObserver(() => queueSync());
  resizeObserver.observe(field.el);
  return { host, box, line, spans: [] };
}

/** @param {Field} field */
function showMirror(field) {
  const el = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (field.el);
  field.mirror ??= createMirror(field);
  const mirror = field.mirror;
  const text = el.value;
  /** @type {Node[]} */
  const parts = [];
  mirror.spans = [];
  let at = 0;
  for (const mark of field.marks) {
    if (mark.start < at || mark.end > text.length) continue;
    if (mark.start > at) parts.push(document.createTextNode(text.slice(at, mark.start)));
    const span = document.createElement('span');
    span.className = 'u';
    span.textContent = text.slice(mark.start, mark.end);
    parts.push(span);
    mirror.spans.push({ span, mark });
    at = mark.end;
  }
  // A trailing space, so a last empty line still counts for scrolling.
  parts.push(document.createTextNode(`${text.slice(at)} `));
  mirror.line.replaceChildren(...parts);
  layOut(field);
  sync(field);
  updatePolling();
}

/**
 * Copy what decides where the field's text goes onto its mirror.
 * @param {Field} field
 */
function layOut(field) {
  const el = field.el;
  const { box } = /** @type {Mirror} */ (field.mirror);
  const style = getComputedStyle(el);
  for (const prop of COPIED) box.style[prop] = style[prop];
  const single = el.tagName === 'INPUT';
  box.classList.toggle('single', single);
  if (!single) box.style.whiteSpace = style.whiteSpace || 'pre-wrap';
  // The field's scroll bar takes from its text's width; the mirror has none.
  const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth - borders);
  box.style.paddingRight = `${parseFloat(style.paddingRight) + scrollbar}px`;
  box.style.width = `${el.offsetWidth}px`;
  box.style.height = `${el.offsetHeight}px`;
}

/**
 * The part of an element's box that's on screen, after every ancestor that
 * clips what overflows it.
 * @param {HTMLElement} el
 * @param {DOMRect} rect
 */
function visiblePart(el, rect) {
  let top = Math.max(rect.top, 0);
  let left = Math.max(rect.left, 0);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  let right = Math.min(rect.right, window.innerWidth);
  for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const clip = node.getBoundingClientRect();
    top = Math.max(top, clip.top);
    left = Math.max(left, clip.left);
    bottom = Math.min(bottom, clip.bottom);
    right = Math.min(right, clip.right);
  }
  return { top, left, bottom, right };
}

/**
 * Whether the field is what's on top where it shows: not under a menu,
 * a dialog, or another window's part of the page.
 * @param {HTMLElement} el
 * @param {{ top: number, left: number, bottom: number, right: number }} part
 */
function onTop(el, part) {
  const root = /** @type {Document | ShadowRoot} */ (el.getRootNode());
  const x = (part.left + part.right) / 2;
  const y = (part.top + part.bottom) / 2;
  const hit = root.elementFromPoint ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y);
  return !hit || hit === el || el.contains(hit);
}

/**
 * Put a field's mirror where the field is now, scrolled as it is.
 * @param {Field} field
 */
function sync(field) {
  const mirror = field.mirror;
  if (!mirror) return;
  const el = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (field.el);
  if (!el.isConnected) {
    forget(field);
    return;
  }
  const rect = el.getBoundingClientRect();
  const part = visiblePart(el, rect);
  const shown = rect.width > 0 && rect.height > 0 && part.bottom > part.top && part.right > part.left && onTop(el, part);
  mirror.box.style.display = shown ? '' : 'none';
  if (!shown) return;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  if (mirror.box.style.width !== `${width}px` || mirror.box.style.height !== `${height}px`) layOut(field);
  mirror.box.style.left = `${rect.left}px`;
  mirror.box.style.top = `${rect.top}px`;
  mirror.box.style.clipPath = `inset(${part.top - rect.top}px ${rect.left + width - part.right}px ${
    rect.top + height - part.bottom
  }px ${part.left - rect.left}px)`;
  mirror.box.scrollTop = el.scrollTop;
  mirror.box.scrollLeft = el.scrollLeft;
}

function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => {
    syncQueued = false;
    for (const field of [...fields.values()]) sync(field);
  });
}

/**
 * While any mirror is up, look again every second too: the page can move a
 * field without scrolling or resizing anything (a panel opening above it).
 */
function updatePolling() {
  const any = [...fields.values()].some((field) => field.mirror);
  if (any && !pollTimer) pollTimer = setInterval(queueSync, 1000);
  if (!any && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Right-clicking and fixing
// ---------------------------------------------------------------------------

/**
 * @param {DOMRectList} rects
 * @param {number} x
 * @param {number} y
 */
function hits(rects, x, y) {
  // A little below the text too, where the underline is.
  for (const r of rects) if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 4) return true;
  return false;
}

/** @param {Field} field @param {number} x @param {number} y @returns {Mark | null} */
function markAt(field, x, y) {
  if (field.rich) return field.ranges.find(({ range }) => hits(range.getClientRects(), x, y))?.mark ?? null;
  return field.mirror?.spans.find(({ span }) => hits(span.getClientRects(), x, y))?.mark ?? null;
}

/**
 * Replace a mark's text as typing it would, so the page hears about it and
 * undo takes it back.
 * @param {Field} field
 * @param {Mark} mark
 * @param {string} replacement
 */
function apply(field, mark, replacement) {
  const el = field.el;
  if (field.rich) {
    const entry = field.ranges.find((r) => r.mark === mark);
    if (!entry || entry.range.toString().replace(/\u00a0/g, ' ') !== mark.text) return;
    el.focus({ preventScroll: true });
    const selection = getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(entry.range.cloneRange());
    const done = replacement ? document.execCommand('insertText', false, replacement) : document.execCommand('delete');
    if (!done) {
      const range = entry.range;
      range.deleteContents();
      if (replacement) range.insertNode(document.createTextNode(replacement));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: replacement }));
    }
  } else {
    const control = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (el);
    if (!field.marks.includes(mark) || control.value.slice(mark.start, mark.end) !== mark.text) return;
    control.focus({ preventScroll: true });
    control.setSelectionRange(mark.start, mark.end);
    const done = replacement ? document.execCommand('insertText', false, replacement) : document.execCommand('delete');
    if (!done) {
      control.setRangeText(replacement, mark.start, mark.end, 'end');
      control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: replacement }));
    }
  }
  schedule(field, FOCUS_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.addEventListener(
  'focusin',
  (event) => {
    const found = fieldOf(eventTarget(event));
    if (found) schedule(track(found.el, found.rich), FOCUS_DELAY_MS);
  },
  true,
);

document.addEventListener(
  'input',
  (event) => {
    const found = fieldOf(eventTarget(event));
    if (!found) return;
    const field = track(found.el, found.rich);
    // A check under way is for text that's gone.
    field.seq++;
    if (field.rich) editedRich(field);
    else editedText(field);
    schedule(field, TYPING_DELAY_MS);
  },
  true,
);

document.addEventListener('scroll', () => {
  if (fields.size) queueSync();
}, { capture: true, passive: true });
window.addEventListener('resize', () => {
  if (fields.size) queueSync();
}, { passive: true });

// Before the menu opens (the browser asks for it only once this event is
// through), say which issue it's for. Synchronously, so main has it first.
window.addEventListener(
  'contextmenu',
  (event) => {
    lastContext = null;
    if (!fields.size) return;
    const found = fieldOf(eventTarget(event));
    const field = found && fields.get(found.el);
    if (!field || !field.marks.length) return;
    const mark = markAt(field, event.clientX, event.clientY);
    if (!mark) {
      ipcRenderer.sendSync('grammar:context', null);
      return;
    }
    const token = nextToken++;
    lastContext = { token, field, mark };
    ipcRenderer.sendSync('grammar:context', { token, hash: mark.hash });
  },
  true,
);

ipcRenderer.on('grammar:apply', (_event, payload) => {
  const { token, replacement } = /** @type {{ token?: unknown, replacement?: unknown }} */ (payload ?? {});
  const context = lastContext;
  if (!context || context.token !== token || typeof replacement !== 'string') return;
  lastContext = null;
  apply(context.field, context.mark, replacement);
});

// The settings or what's ignored changed: check again.
ipcRenderer.on('grammar:refresh', () => {
  for (const field of [...fields.values()]) schedule(field, 0);
});
