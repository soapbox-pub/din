import { memo, useEffect, useRef, useState } from 'react';
import { Keyboard, Settings2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useBarSide } from '@/contexts/BarSideContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useKeyboardStatus, useSelectKeyboardLayout } from '@/hooks/useKeyboardLayout';
import { LAYOUT_SWITCH_KEYS, getKeyboardBridge, layoutKey, layoutTag } from '@/lib/keyboard';
import { announce } from '@/lib/announce';
import { OsdLayer } from './OsdLayer';

/**
 * The keyboard's layouts, in the menu bar, as a Mac's input menu: the tag
 * of the one typing ("US", "DE"); clicking lists them all to switch to,
 * and Keyboard Settings. Shown only where Din switches between several
 * (DinOS, with more than one in Settings → Keyboard).
 */
export const KeyboardMenuItem = memo(function KeyboardMenuItem() {
  const side = useBarSide();
  const status = useKeyboardStatus();
  const select = useSelectKeyboardLayout();
  const { open } = useWindowActions();

  const data = status.data;
  if (!getKeyboardBridge() || !data?.canSwitch) return null;

  const { layouts, layout } = data;
  const label = `Keyboard layout: ${layout.name}`;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className="grid h-7 min-w-7 place-items-center rounded-md px-1 text-foreground/90 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-foreground/10"
        >
          <span className="rounded-[0.3125rem] border border-current px-1 text-[0.625rem] leading-[0.875rem] font-semibold tracking-wide">
            {layoutTag(layout, layouts)}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="end" sideOffset={8} className="min-w-64 max-w-80">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Keyboard layout</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={String(data.active)}
          onValueChange={(value) => select.mutate(Number(value))}
        >
          {layouts.map((entry, index) => (
            <DropdownMenuRadioItem key={layoutKey(entry)} value={String(index)}>
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <DropdownMenuShortcut className="font-semibold">{layoutTag(entry, layouts)}</DropdownMenuShortcut>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {LAYOUT_SWITCH_KEYS.previous}: the last one · {LAYOUT_SWITCH_KEYS.next}: the next
        </p>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => open('settings', { section: 'keyboard' })}>
          <Settings2 aria-hidden />
          Keyboard Settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** How long the layout's name stays on screen after a switch. */
const OSD_VISIBLE_MS = 1200;

/**
 * The layout switched to, on screen for a moment, as the volume's is:
 * Ctrl+Space changes it with nothing else to see but the menu bar's tag.
 * Renders nothing until the layout typing changes.
 */
export function KeyboardLayoutOsd() {
  const status = useKeyboardStatus();
  const [shown, setShown] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const last = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const data = status.data;
  const key = data ? layoutKey(data.layout) : null;
  const name = data?.layout.name ?? null;
  const several = (data?.layouts.length ?? 0) > 1;

  useEffect(() => {
    if (!key || !name) return;
    const before = last.current;
    last.current = key;
    if (before === null || before === key || !several) return;
    announce(`Keyboard layout: ${name}`);
    setShown(name);
    setVisible(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVisible(false), OSD_VISIBLE_MS);
  }, [key, name, several]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (!shown) return null;
  return (
    <OsdLayer aria-hidden visible={visible}>
      <div className="flex items-center gap-3 glass-surface rounded-2xl px-4 py-3">
        <Keyboard className="size-6 shrink-0 text-foreground" />
        <span className="text-sm font-medium text-foreground">{shown}</span>
      </div>
    </OsdLayer>
  );
}
