import type { ComponentProps } from 'react';
import { useTabTransfer, type TabTransferOptions } from '@/hooks/useTabTransfer';
import { useWindowChrome } from '@/contexts/WindowChromeContext';
import { TabStrip as SharedTabStrip } from '@/shared/TabStrip';

export type { TabDescriptor } from '@/shared/TabStrip';

/**
 * The shared tab strip (src/shared/TabStrip.tsx) for apps in the desktop's
 * tree: tabs move between the app's windows through useTabTransfer, and a
 * window's only tab drags the window through its chrome, like Chrome's.
 */
export function TabStrip({
  transfer,
  ...props
}: Omit<ComponentProps<typeof SharedTabStrip>, 'transfer' | 'moveWindow'> & {
  /** Let tabs move between the app's windows. */
  transfer?: TabTransferOptions;
}) {
  const tabTransfer = useTabTransfer(transfer, props.tabs.length);
  const chrome = useWindowChrome();
  return (
    <SharedTabStrip
      {...props}
      transfer={tabTransfer}
      moveWindow={props.tabs.length === 1 ? chrome : undefined}
    />
  );
}
