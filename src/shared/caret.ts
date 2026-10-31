/**
 * Where the text caret is, for power mode (src/lib/powerMode.ts): in the
 * desktop's own fields, and in apps' by way of window.din's runtime, which
 * bundles this file in (so it must stay free of imports).
 */

/** The caret, in the document's viewport CSS pixels, and the text's color there (a CSS color, or '' when unseen). */
export interface CaretSpot {
  x: number;
  y: number;
  color: string;
}

/** Inputs whose value has a caret: the rest (checkboxes, colors, dates…) aren't typed in. */
const TEXT_INPUTS = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number']);

/** What a mirror copies of a field's style, so its text wraps and sits as the field's does. */
const MIRRORED = [
  'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize',
] as const;

/** The focused element, through open shadow roots. */
function focused(doc: Document): Element | null {
  let el = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** Whether keys typed with this focused are typed into text. */
export function isTextEntry(el: Element | null): el is HTMLElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type) && !el.readOnly && !el.disabled;
  return el instanceof HTMLElement && el.isContentEditable;
}

/** The text's color in `el`, or '' for none to see (xterm's hidden textarea). */
function textColor(el: Element): string {
  const style = getComputedStyle(el);
  const color = style.color.trim();
  if (style.opacity === '0' || /^(transparent|rgba\(.*,\s*0\)|rgb\(.*\/\s*0\))$/.test(color)) return '';
  return color;
}

/** The caret in an input or textarea: a copy of the field's text up to it, laid out as the field lays it out. */
function fieldCaret(el: HTMLInputElement | HTMLTextAreaElement): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  let at: number | null = null;
  try {
    at = el.selectionEnd;
  } catch {
    // Number inputs have no selection.
  }
  const style = getComputedStyle(el);
  if (at === null) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const mirror = el.ownerDocument.createElement('div');
  const s = mirror.style;
  for (const prop of MIRRORED) s[prop] = style[prop];
  s.position = 'absolute';
  s.visibility = 'hidden';
  s.left = '0';
  s.top = '0';
  s.overflow = 'hidden';
  const textarea = el instanceof HTMLTextAreaElement;
  s.whiteSpace = textarea ? 'pre-wrap' : 'pre';
  s.overflowWrap = textarea ? 'break-word' : 'normal';
  if (!textarea) s.lineHeight = style.height;
  const before = el.value.slice(0, at);
  mirror.textContent = el.type === 'password' ? '•'.repeat(before.length) : before;
  const marker = el.ownerDocument.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  el.ownerDocument.body.appendChild(mirror);
  const height = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || marker.offsetHeight;
  const x = rect.left + el.clientLeft + marker.offsetLeft - el.scrollLeft;
  const y = rect.top + el.clientTop + marker.offsetTop - el.scrollTop + (textarea ? height / 2 : 0);
  mirror.remove();
  return {
    x: Math.min(Math.max(x, rect.left), rect.right),
    y: textarea ? Math.min(Math.max(y, rect.top), rect.bottom) : rect.top + rect.height / 2,
  };
}

/** The caret in editable content (CodeMirror, rich text): the selection's end, or the element it's in. */
function editableCaret(el: HTMLElement): { x: number; y: number; at: Element } {
  const selection = el.ownerDocument.getSelection();
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(false);
    const node = range.endContainer;
    const at = node instanceof Element ? node : (node.parentElement ?? el);
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    if (rect.height > 0) return { x: rect.left, y: rect.top + rect.height / 2, at };
    // An empty line has no box of its own; its element does.
    const box = at.getBoundingClientRect();
    if (box.height > 0) return { x: box.left, y: box.top + Math.min(box.height, 24) / 2, at };
  }
  const box = el.getBoundingClientRect();
  return { x: box.left, y: box.top + Math.min(box.height, 24) / 2, at: el };
}

/** Where the caret of the focused text field is, or null when no text field has focus. */
export function caretSpot(doc: Document = document): CaretSpot | null {
  const el = focused(doc);
  if (!isTextEntry(el)) return null;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const { x, y } = fieldCaret(el);
    return { x, y, color: textColor(el) };
  }
  const { x, y, at } = editableCaret(el);
  return { x, y, color: textColor(at) };
}

/** Whether a keydown types into (or deletes from) text, rather than moving or commanding. */
export function typesText(e: KeyboardEvent): boolean {
  if (!e.isTrusted || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  return e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete';
}
