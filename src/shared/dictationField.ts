/**
 * Dictation typing into a text field or editable element as it's heard, as
 * a phone's keyboard does: what's final stays, and the words after it that
 * may still change are shown in the field and replaced as they're heard
 * better. Typed with execCommand('insertText'), so undo and React's
 * onChange work as if from the keyboard.
 *
 * Used by the desktop's dictation (src/lib/dictation.ts) and by apps typing
 * SpeechRecognition's results (src/shared/assistant/appHost.tsx).
 */

type TextField = HTMLTextAreaElement | HTMLInputElement;

/** A space before the text unless it starts a line or follows one, or is punctuation. */
export function spaced(before: string, text: string): string {
  return before && !/\s$/.test(before) && !/^[.,!?;:]/.test(text) ? ` ${text}` : text;
}

function isTextField(element: Element): element is TextField {
  return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement;
}

/**
 * A function that types `final` into `element` at the cursor (or where the
 * last words that weren't final are) and shows `interim` after it,
 * replacing the interim text it showed before; ('', '') takes that away.
 * Interim text is only shown while the element has the keyboard, so
 * dictating doesn't pull focus back from where the user went; final text
 * focuses it.
 */
export function dictationTyper(element: TextField | HTMLElement): (final: string, interim: string) => void {
  return isTextField(element) ? fieldTyper(element) : editableTyper(element);
}

function fieldTyper(field: TextField): (final: string, interim: string) => void {
  /** The interim text in the field, and where it starts. */
  let shown: { start: number; text: string } | null = null;
  return (final, interim) => {
    if (!field.isConnected) return;
    if (!final && !interim && !shown) return;
    if (field.ownerDocument.activeElement !== field) {
      if (!final) return;
      field.focus();
    }
    const value = field.value;
    const selStart = field.selectionStart ?? value.length;
    const selEnd = field.selectionEnd ?? selStart;
    // Where the last interim text was, if the user hasn't changed it.
    const prev = shown && value.slice(shown.start, shown.start + shown.text.length) === shown.text ? shown : null;
    const start = prev ? prev.start : selStart;
    const end = prev ? prev.start + prev.text.length : selEnd;
    const before = value.slice(0, start);
    const f = final ? spaced(before, final) : '';
    const i = interim ? spaced(before + f, interim) : '';
    const write = f + i;
    field.setSelectionRange(start, end);
    if (write) field.ownerDocument.execCommand('insertText', false, write);
    else if (end > start) field.ownerDocument.execCommand('delete');
    shown = i ? { start: start + f.length, text: i } : null;
    // The user's cursor stays where they put it, if that wasn't at the words.
    if (prev && !(selStart === selEnd && selEnd === end)) {
      const shift = write.length - (end - start);
      const at = (n: number) => (n >= end ? n + shift : n <= start ? n : start);
      field.setSelectionRange(at(selStart), at(selEnd));
    }
  };
}

function editableTyper(element: HTMLElement): (final: string, interim: string) => void {
  const doc = element.ownerDocument;
  /** The interim text in the element, as a range over it. */
  let shown: { range: Range; text: string } | null = null;
  return (final, interim) => {
    if (!element.isConnected) return;
    if (!final && !interim && !shown) return;
    if (doc.activeElement !== element && !element.contains(doc.activeElement)) {
      if (!final) return;
      element.focus();
    }
    const selection = doc.getSelection();
    if (!selection) return;
    let range: Range;
    if (shown && element.contains(shown.range.commonAncestorContainer) && shown.range.toString() === shown.text) {
      range = shown.range;
    } else if (selection.rangeCount && element.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      range = selection.getRangeAt(0).cloneRange();
    } else {
      range = doc.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
    }
    const preceding = doc.createRange();
    preceding.selectNodeContents(element);
    preceding.setEnd(range.startContainer, range.startOffset);
    const before = preceding.toString();
    const f = final ? spaced(before, final) : '';
    const i = interim ? spaced(before + f, interim) : '';
    selection.removeAllRanges();
    selection.addRange(range);
    if (f) doc.execCommand('insertText', false, f);
    else if (!i && !range.collapsed) doc.execCommand('delete');
    shown = null;
    if (!i || !selection.rangeCount) return;
    // A collapsed range where the interim text starts: text typed at it
    // goes after it, so it stays at the start.
    const start = selection.getRangeAt(0).cloneRange();
    start.collapse(true);
    doc.execCommand('insertText', false, i);
    if (!selection.rangeCount) return;
    const end = selection.getRangeAt(0);
    const words = doc.createRange();
    words.setStart(start.startContainer, start.startOffset);
    words.setEnd(end.endContainer, end.endOffset);
    shown = { range: words, text: i };
  };
}
