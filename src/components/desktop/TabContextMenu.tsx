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
 * A tab's right-click menu: open a new tab or reopen a closed one, app-specific
 * `items`, pin it (when the app has pinned tabs), move it to a new window or to
 * another of the app's windows (when the strip supports moving tabs), and close
 * it (or the tabs around it). `children` is the tab element itself.
 */
export function TabContextMenu({
  tabId,
  transfer,
  onClose,
  onNew,
  newLabel = 'New tab',
  onReopen,
  onCloseOthers,
  onCloseToRight,
  canCloseOthers = true,
  canCloseToRight = true,
  pinned,
  onTogglePin,
  items,
  onCloseAutoFocus,
  children,
}: {
  tabId: string;
  transfer: TabTransfer;
  onClose: () => void;
  onNew?: () => void;
  newLabel?: string;
  onReopen?: () => void;
  onCloseOthers?: () => void;
  onCloseToRight?: () => void;
  /** False greys the item out (there's nothing to close). */
  canCloseOthers?: boolean;
  canCloseToRight?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  /** App-specific items, shown after the new-tab items. */
  items?: ReactNode;
  /** An item that starts inline editing prevents this, so the field keeps focus. */
  onCloseAutoFocus?: (event: Event) => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52" onCloseAutoFocus={onCloseAutoFocus}>
        {(onNew || onReopen) && (
          <>
            {onNew && <ContextMenuItem onSelect={onNew}>{newLabel}</ContextMenuItem>}
            {onReopen && <ContextMenuItem onSelect={onReopen}>Reopen closed tab</ContextMenuItem>}
            <ContextMenuSeparator />
          </>
        )}
        {items && (
          <>
            {items}
            <ContextMenuSeparator />
          </>
        )}
        {onTogglePin && (
          <>
            <ContextMenuItem onSelect={onTogglePin}>{pinned ? 'Unpin tab' : 'Pin tab'}</ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
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
        {onCloseOthers && (
          <ContextMenuItem disabled={!canCloseOthers} onSelect={onCloseOthers}>
            Close other tabs
          </ContextMenuItem>
        )}
        {onCloseToRight && (
          <ContextMenuItem disabled={!canCloseToRight} onSelect={onCloseToRight}>
            Close tabs to the right
          </ContextMenuItem>
        )}
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
