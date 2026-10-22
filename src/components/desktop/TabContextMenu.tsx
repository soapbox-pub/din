import type { ReactNode } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { TabTransfer } from '@/hooks/useTabTransfer';

/**
 * A tab's right-click menu: move it to a new window or to another of the
 * app's windows (when the strip supports moving tabs), and close it.
 * `children` is the tab element itself.
 */
export function TabContextMenu({
  tabId,
  transfer,
  onClose,
  children,
}: {
  tabId: string;
  transfer: TabTransfer;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {transfer.enabled && (
          <>
            <ContextMenuItem
              disabled={!transfer.canDetach}
              onSelect={() => transfer.moveToNewWindow(tabId)}
            >
              Move to new window
            </ContextMenuItem>
            <MoveToWindowMenu tabId={tabId} transfer={transfer} />
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={onClose}>Close tab</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The "Move to window" submenu, listing the app's other windows. */
function MoveToWindowMenu({ tabId, transfer }: { tabId: string; transfer: TabTransfer }) {
  // Read when the menu opens; the content only renders while it's open.
  const windows = transfer.otherWindows();
  if (windows.length === 0) return null;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>Move to window</ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-56">
        {windows.map((w) => (
          <ContextMenuItem key={w.windowId} onSelect={() => transfer.moveToWindow(tabId, w.windowId)}>
            <span className="truncate">{w.title}</span>
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
