import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { openSearchPanel, setSearchQuery } from '@codemirror/search';
import type { EditorView, Panel } from '@codemirror/view';
import { FindBar, type FindBarStore } from './FindBar';

interface PanelStore extends FindBarStore {
  notify(): void;
}

const stores = new WeakMap<EditorView, PanelStore>();
const pendingReplace = new WeakMap<EditorView, boolean>();

/** Open the find bar, with its replace row when `replace` is set. */
export function openFind(view: EditorView, replace: boolean) {
  const store = stores.get(view);
  if (store && replace && !store.replace) store.setReplace(true);
  if (!store) pendingReplace.set(view, replace);
  openSearchPanel(view);
}

/** CodeMirror's search panel, drawn by Din (search({ createPanel })). */
export function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  const listeners = new Set<() => void>();
  let version = 0;
  let replace = pendingReplace.get(view) ?? false;
  pendingReplace.delete(view);
  const store: PanelStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
    get replace() {
      return replace;
    },
    setReplace(on) {
      replace = on;
      store.notify();
    },
    notify() {
      version++;
      for (const listener of listeners) listener();
    },
  };
  stores.set(view, store);
  const root = createRoot(dom);
  root.render(createElement(FindBar, { view, store }));
  return {
    dom,
    top: true,
    update(update) {
      if (update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))) {
        store.notify();
      }
    },
    destroy() {
      stores.delete(view);
      // Not while CodeMirror is mid-update, which may be inside a React render.
      queueMicrotask(() => root.unmount());
    },
  };
}
