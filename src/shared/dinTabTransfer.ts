import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragPoint, TearOff } from '@/hooks/useDragReorder';
import type { Din } from '@/sdk';
import type { TabTransfer } from '@/shared/TabContextMenu';

/**
 * Tabs moving between an app's windows, for a tab strip in an app (the
 * desktop's strips use useTabTransfer): dragged off the strip onto another
 * of the app's windows (whose strip marks where it'll land), into a new
 * window when dropped anywhere else, or from the tab's context menu.
 *
 * The desktop says which of the app's windows is frontmost under the
 * pointer (din.window.tabDragMove) and shows the tab's label there; the
 * tab itself travels to that window on a BroadcastChannel, or, for a new
 * window, waits in din.app.session for it.
 *
 * A channel reaches every window of the app and nothing else: each app is
 * an origin of its own, and the only foreign content apps frame can't join
 * (Mail's messages run no scripts; Media Player's skins are sandboxed to an
 * opaque origin). So a message names the window it's for, and the others
 * ignore it. They're the same app, so a tab's contents (a terminal's
 * hand-over token) seen by another of its windows gives nothing away.
 */
export interface DinTabTransferOptions {
  din: Din;
  /** Launch params for a new window, besides the tab it opens with. */
  params?: Record<string, unknown>;
  /** The tab's label while it's dragged between windows. */
  label: (id: string) => string;
  /**
   * Remove a tab from this window and return what another window needs to
   * rebuild it (structured-cloneable). Taking the last tab closes the window.
   */
  take: (id: string) => unknown | Promise<unknown>;
  /** Add a tab taken from another window, at `index` in the strip. */
  receive: (payload: unknown, index: number) => void;
}

const MESSAGE = 'din:tab';
const CHANNEL = 'din:tabs';
const ADOPT_PARAM = 'adoptTab';

/** Where a new window's title bar goes, relative to the pointer that dropped its tab. */
const GRAB = { x: 100, y: 16 };

interface TabMessage {
  type: typeof MESSAGE;
  /** The window it's for. */
  to: string;
  payload: unknown;
  /** Where in the strip: a slot index, or the x it was dropped at. */
  index?: number;
  x?: number;
}

function isTabMessage(data: unknown): data is TabMessage {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === MESSAGE;
}

/** Where a tab dropped at x lands in a strip: its index, and the x of the gap (for the marker). */
function slotAt(list: HTMLElement, x: number): { index: number; x: number } {
  const tabs = [...list.querySelectorAll<HTMLElement>(':scope > [role="tab"]')];
  let index = 0;
  for (const tab of tabs) {
    const r = tab.getBoundingClientRect();
    if (r.left + r.width / 2 < x) index++;
  }
  if (tabs.length === 0) return { index: 0, x: list.getBoundingClientRect().left };
  if (index < tabs.length) return { index, x: tabs[index].getBoundingClientRect().left - 2 };
  return { index, x: tabs[tabs.length - 1].getBoundingClientRect().right + 2 };
}

/** Whether this window was opened to adopt a tab (so it shouldn't start with one of its own). */
export function hasAdoptedTab(din: Din): boolean {
  return typeof din.app.launch.params[ADOPT_PARAM] === 'string';
}

/**
 * The tab a window was opened to adopt (a tab dropped away from every
 * window), if any. Read it when the window starts; it's removed once read.
 */
export async function adoptedTab(din: Din): Promise<unknown> {
  const token = din.app.launch.params[ADOPT_PARAM];
  if (typeof token !== 'string') return undefined;
  const payload = await din.app.session.get(token);
  din.app.session.set(token, undefined);
  const place = din.app.launch.params.place as { x?: unknown; y?: unknown } | undefined;
  if (typeof place?.x === 'number' && typeof place.y === 'number') window.moveTo(place.x, place.y);
  return payload;
}

export function useDinTabTransfer(options: DinTabTransferOptions, tabCount: number): TabTransfer {
  const { din } = options;
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const latest = useRef({ options, tabCount, list });
  useLayoutEffect(() => {
    latest.current = { options, tabCount, list };
  });

  // The app's other windows, for "Move to window": refreshed when this one
  // comes to the front (and a tab menu can only open then).
  const [others, setOthers] = useState<{ windowId: string; title: string }[]>([]);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void din.app.windows().then((ws) => {
        if (live) setOthers(ws.map((w) => ({ windowId: w.id, title: w.title })));
      });
    refresh();
    let focused = din.window.state.focused;
    const off = din.window.onChange((s) => {
      if (s.focused && !focused) refresh();
      focused = s.focused;
    });
    window.addEventListener('pointerdown', refresh, true);
    return () => {
      live = false;
      off();
      window.removeEventListener('pointerdown', refresh, true);
    };
  }, [din]);

  // Another window's tab arriving, and where one hovering would land.
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    const open = new BroadcastChannel(CHANNEL);
    channel.current = open;
    open.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!isTabMessage(data) || data.to !== din.window.state.id) return;
      const strip = latest.current.list;
      const index = data.index ?? (strip && typeof data.x === 'number' ? slotAt(strip, data.x).index : Infinity);
      latest.current.options.receive(data.payload, index);
      window.focus();
    };
    return () => {
      open.close();
      if (channel.current === open) channel.current = null;
    };
  }, [din]);
  const marker = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const hide = () => {
      marker.current?.remove();
      marker.current = null;
    };
    const off = din.window.onTabHover((at) => {
      const strip = latest.current.list;
      if (!at || !strip) {
        hide();
        return;
      }
      if (!marker.current) {
        marker.current = document.createElement('div');
        marker.current.setAttribute('aria-hidden', 'true');
        marker.current.className = 'pointer-events-none fixed z-[2147483646] w-0.5 rounded-full bg-primary';
        document.body.appendChild(marker.current);
      }
      const r = strip.getBoundingClientRect();
      marker.current.style.left = `${slotAt(strip, at.x).x - 1}px`;
      marker.current.style.top = `${r.top + 4}px`;
      marker.current.style.height = `${Math.max(0, r.height - 8)}px`;
    });
    return () => {
      off();
      hide();
    };
  }, [din]);

  const moveToWindow = useCallback(async (id: string, windowId: string, index = Infinity) => {
    const payload = await latest.current.options.take(id);
    channel.current?.postMessage({ type: MESSAGE, to: windowId, payload, index: Number.isFinite(index) ? index : undefined } satisfies TabMessage);
  }, []);

  const moveToNewWindow = useCallback(async (id: string, point?: DragPoint) => {
    const { options: o } = latest.current;
    const { bounds } = din.window.state;
    const token = `tab-${crypto.randomUUID()}`;
    din.app.session.set(token, await o.take(id));
    const place = point
      ? { x: Math.round(bounds.x + point.x - GRAB.x), y: Math.max(0, Math.round(bounds.y + point.y - GRAB.y)) }
      : undefined;
    await din.app.open(din.app.id, { ...o.params, width: bounds.width, height: bounds.height, [ADOPT_PARAM]: token, ...(place ? { place } : {}) });
  }, [din]);

  const tearOff = useMemo<TearOff>(() => ({
    enabled: true,
    onHover: (id, point) => {
      // Back on the strip: the desktop's label and the other window's marker go.
      if (point) void din.window.tabDragMove(point, latest.current.options.label(id));
      else void din.window.tabDragEnd({ x: -1, y: -1 });
    },
    onDrop: (id, point) => {
      void din.window.tabDragEnd(point).then((target) => {
        const { tabCount } = latest.current;
        if (target && target.windowId !== din.window.state.id) {
          void Promise.resolve(latest.current.options.take(id)).then((payload) =>
            channel.current?.postMessage({ type: MESSAGE, to: target.windowId, payload, x: target.at.x } satisfies TabMessage),
          );
          return;
        }
        if (target) return;
        if (tabCount > 1) {
          void moveToNewWindow(id, point);
        } else {
          // A window's only tab carries the window along with it.
          const { bounds } = din.window.state;
          window.moveTo(Math.round(bounds.x + point.x - GRAB.x), Math.max(0, Math.round(bounds.y + point.y - GRAB.y)));
        }
      });
    },
  }), [din, moveToNewWindow]);

  const otherWindows = useCallback(() => others, [others]);

  return { setList, tearOff, enabled: true, canDetach: tabCount > 1, moveToNewWindow, moveToWindow, otherWindows };
}
