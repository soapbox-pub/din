export interface Ask {
  title: string;
  label: string;
  initial: string;
  confirm: string;
  resolve: (value: string | null) => void;
}

let current: Ask | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Ask for a line of text (a name, a URL), as Electron has no window.prompt. */
export function askText(title: string, label: string, initial = '', confirm = 'OK'): Promise<string | null> {
  current?.resolve(null);
  return new Promise((resolve) => {
    current = { title, label, initial, confirm, resolve };
    emit();
  });
}

export function finishAsk(value: string | null) {
  const ask = current;
  current = null;
  emit();
  ask?.resolve(value);
}

export function currentAsk(): Ask | null {
  return current;
}

export function subscribeAsk(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
