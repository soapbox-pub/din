import { createContext, useContext, useSyncExternalStore } from 'react';
import type { HostToVm } from '@/shared/skins/wmp/protocol';
import type { SkinImages } from '@/shared/skins/wmp/images';

type Attrs = Record<string, unknown>;

/** The host's copy of every element's attributes, as the VM last patched them. */
export class Mirror {
  private attrs = new Map<string, Attrs>();
  private listeners = new Map<string, Set<() => void>>();

  get = (iid: string): Attrs | undefined => this.attrs.get(iid);

  subscribe = (iid: string, listener: () => void) => {
    let set = this.listeners.get(iid);
    if (!set) this.listeners.set(iid, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  };

  apply(patch: Record<string, Attrs>) {
    for (const [iid, changes] of Object.entries(patch)) {
      this.attrs.set(iid, { ...(this.attrs.get(iid) ?? {}), ...changes });
      this.listeners.get(iid)?.forEach((l) => l());
    }
  }
}

export interface ViewContextValue {
  mirror: Mirror;
  images: SkinImages;
  send: (msg: HostToVm) => void;
  /** Album art for WMPImage_AlbumArt* names. */
  albumArt: string | null;
}

export const ViewContext = createContext<ViewContextValue | null>(null);

export function useView(): ViewContextValue {
  const ctx = useContext(ViewContext);
  if (!ctx) throw new Error('WMP elements need a view');
  return ctx;
}

const EMPTY: Attrs = {};

export function useAttrs(iid: string): Attrs {
  const { mirror } = useView();
  return useSyncExternalStore(
    (l) => mirror.subscribe(iid, l),
    () => mirror.get(iid) ?? EMPTY,
  );
}
