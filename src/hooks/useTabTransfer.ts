import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import type { DragPoint, TearOff } from '@/hooks/useDragReorder';
import type { WindowParams } from '@/hooks/useWindows';
import {
  dropSlotAt,
  hideDropIndicator,
  parkTab,
  registerTabDropTarget,
  showDropIndicator,
  tabDropTargetAt,
  tabDropTargetFor,
  tabDropTargets,
} from '@/lib/tabTransfer';
import type { TabTransfer } from '@/shared/TabContextMenu';

export type { TabTransfer };

/** What an app tells its tab strip so tabs can move between its windows. */
export interface TabTransferOptions {
  windowId: string;
  /** The app new windows open as. */
  appId: string;
  /** Launch params for a new window, besides the tab it opens with. */
  params?: WindowParams;
  /** Tabs only move between strips of the same group (see lib/tabTransfer). */
  group: string;
  /** What the window is showing, for other windows' "Move to window" menus. */
  title: string;
  /**
   * Remove a tab from this window and return what another window needs to
   * rebuild it. Taking the last tab closes the window.
   */
  take: (id: string) => unknown;
  /** Add a tab taken from another window, at `index` in the strip. */
  receive: (payload: unknown, index: number) => void;
}

/** Where a new window's title bar goes, relative to the pointer that dropped its tab. */
const GRAB = { x: 100, y: 16 };

/** The workspace a window sits in, for converting to window coordinates. */
function workspaceRect(list: HTMLElement | null): DOMRect | undefined {
  return list?.closest('section')?.parentElement?.getBoundingClientRect();
}

/**
 * Lets a tab strip's tabs move to other windows of its app: dragged off the
 * strip onto another window's (with a drop indicator showing where they'll
 * land), into a new window when dropped anywhere else, or from the tab's
 * context menu. The strip passes `tearOff` to useDragReorder and puts
 * `setList` (a callback ref) on its tablist.
 */
export function useTabTransfer(options: TabTransferOptions | undefined, tabCount: number): TabTransfer {
  const { open, move, focus } = useWindowActions();
  // The tablist, set through the returned callback ref.
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const latest = useRef({ options, tabCount, list });
  useLayoutEffect(() => {
    latest.current = { options, tabCount, list };
  });

  const enabled = options !== undefined;
  const windowId = options?.windowId;
  const group = options?.group;
  useEffect(() => {
    if (!list || windowId === undefined || group === undefined) return;
    return registerTabDropTarget({
      windowId,
      group,
      element: list,
      title: () => latest.current.options?.title ?? '',
      receive: (payload, index) => latest.current.options?.receive(payload, index),
    });
  }, [list, windowId, group]);

  useEffect(() => hideDropIndicator, []);

  const moveToWindow = useCallback((id: string, targetWindowId: string, index = Infinity) => {
    const o = latest.current.options;
    const target = o && tabDropTargetFor(o.group, targetWindowId);
    if (!o || !target) return;
    target.receive(o.take(id), index);
    focus(target.windowId);
  }, [focus]);

  const moveToNewWindow = useCallback((id: string, point?: DragPoint) => {
    const { options: o, list } = latest.current;
    if (!o) return;
    const section = list?.closest('section');
    const ws = workspaceRect(list);
    const token = parkTab(o.take(id));
    const newId = open(o.appId, {
      ...o.params,
      ...(section ? { width: section.offsetWidth, height: section.offsetHeight } : {}),
      adoptTab: token,
    });
    if (newId && point && ws) {
      move(newId, Math.round(point.x - ws.left - GRAB.x), Math.max(0, Math.round(point.y - ws.top - GRAB.y)));
    }
  }, [open, move]);

  const tearOff = useMemo<TearOff>(() => ({
    enabled,
    onHover: (_id, point) => {
      const o = latest.current.options;
      const target = o && point ? tabDropTargetAt(point.x, point.y, o.group) : null;
      if (!point || !target || target.windowId === o?.windowId) hideDropIndicator();
      else showDropIndicator(target.element, point.x);
    },
    onDrop: (id, point) => {
      const { options: o, tabCount, list } = latest.current;
      if (!o) return;
      const target = tabDropTargetAt(point.x, point.y, o.group);
      if (target?.windowId === o.windowId) return;
      if (target) {
        moveToWindow(id, target.windowId, dropSlotAt(target.element, point.x).index);
      } else if (tabCount > 1) {
        moveToNewWindow(id, point);
      } else {
        // A window's only tab carries the window along with it.
        const ws = workspaceRect(list);
        if (ws) move(o.windowId, Math.round(point.x - ws.left - GRAB.x), Math.max(0, Math.round(point.y - ws.top - GRAB.y)));
      }
    },
  }), [enabled, move, moveToWindow, moveToNewWindow]);

  /** The app's other windows a tab could move to, for the context menu. */
  const otherWindows = useCallback(() => {
    const o = latest.current.options;
    return o ? tabDropTargets(o.group, o.windowId).map((t) => ({ windowId: t.windowId, title: t.title() })) : [];
  }, []);

  return { setList, tearOff, enabled, canDetach: tabCount > 1, moveToNewWindow, moveToWindow, otherWindows };
}
