import type { ComponentProps } from 'react';
import { PopoverContent } from '@/components/ui/popover';
import { useBarSide } from '@/contexts/BarSideContext';
import { cn } from '@/lib/utils';

/**
 * A bar item's panel: below it in the menu bar, above it in the taskbar
 * (BarSideContext), a little way off the bar, in the frosted glass of the
 * desktop's other floating panels.
 */
export function BarPopoverContent({ className, ...props }: ComponentProps<typeof PopoverContent>) {
  const side = useBarSide();
  return (
    <PopoverContent
      side={side}
      sideOffset={8}
      className={cn('rounded-2xl', className)}
      {...props}
    />
  );
}
