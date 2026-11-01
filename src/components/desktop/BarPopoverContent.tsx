import type { ComponentProps } from 'react';
import { PopoverContent } from '@/components/ui/popover';
import { useBarSide } from '@/contexts/BarSideContext';

/**
 * A bar item's panel: below it in the menu bar, above it in the taskbar
 * (BarSideContext), a little way off the bar.
 */
export function BarPopoverContent(props: ComponentProps<typeof PopoverContent>) {
  const side = useBarSide();
  return <PopoverContent side={side} sideOffset={8} {...props} />;
}
