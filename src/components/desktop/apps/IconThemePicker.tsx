import { Check } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useIconThemeStatus, useIconThemes, useSetIconTheme } from '@/hooks/useIconTheme';
import { DIN_ICON_THEME } from '@/lib/iconTheme';
import type { IconThemeInfo } from '@/lib/iconTheme';
import { cn } from '@/lib/utils';

/** What the Din theme looks like: Din's own bundled icons. */
const DIN_PREVIEW = [
  '/icons/apps/file-browser.png',
  '/icons/apps/terminal.png',
  '/icons/apps/web-browser.png',
  '/icons/apps/settings.png',
];

/**
 * The system's icon theme (electron/icon-theme.mts): native apps' icons, and
 * those of Din's own apps and file types unless it's Din's own. Shown
 * everywhere, changed where Din can (DinOS, GNOME and the like).
 */
export function IconThemePicker() {
  const status = useIconThemeStatus();
  const themes = useIconThemes();
  const setTheme = useSetIconTheme();

  if (status.isLoading || themes.isLoading) {
    return <Skeleton className="h-40 w-full bg-foreground/10" aria-hidden />;
  }
  if (status.isError || !status.data || !themes.data) {
    return (
      <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">Could not read the icon settings.</p>
      </div>
    );
  }

  const { canChange, shared } = status.data;
  // While a change is in flight, show the requested theme.
  const theme = setTheme.isPending ? setTheme.variables : status.data.theme;
  const choose = (id: string) => {
    if (id !== theme) setTheme.mutate(id);
  };

  // Nothing to pick between: only Din's own icons are installed.
  if (themes.data.every((option) => option.id === DIN_ICON_THEME) && theme === DIN_ICON_THEME) {
    return (
      <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          Din is using its own icons. Add an icon theme to ~/.local/share/icons to change them.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/20 p-3">
      {themes.data.length === 0 ? (
        <p className="text-xs text-muted-foreground">No icon themes are installed.</p>
      ) : (
        <div
          className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2"
          role="radiogroup"
          aria-label="Icons"
        >
          {themes.data.map((option) => (
            <IconThemeOption
              key={option.id}
              option={option}
              selected={theme === option.id}
              disabled={!canChange}
              onChoose={() => choose(option.id)}
            />
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {canChange
          ? 'Icons for apps in the Dock and menus, and for files and folders. Apps with nothing in a theme keep Din’s icon.'
          : 'Din uses your desktop’s icon theme. Change it in your desktop’s settings.'}
        {shared && ' This changes your desktop’s icons too.'}
      </p>
      {setTheme.isError && (
        <p role="alert" className="text-sm text-destructive">
          {setTheme.error instanceof Error ? setTheme.error.message : 'Could not change the icons.'}
        </p>
      )}
    </div>
  );
}

function IconThemeOption({
  option,
  selected,
  disabled,
  onChoose,
}: {
  option: IconThemeInfo;
  selected: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  const preview = option.id === DIN_ICON_THEME ? DIN_PREVIEW : option.preview;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          disabled={disabled}
          onClick={onChoose}
          className={cn(
            'flex w-full flex-col items-start gap-2 rounded-xl border p-3 text-left',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-60',
            selected
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-border/60 text-muted-foreground enabled:hover:bg-foreground/5 enabled:hover:text-foreground',
          )}
        >
          <span className="flex h-10 items-center gap-2" aria-hidden>
            {preview.length > 0 ? (
              preview.map((src) => (
                <img key={src} src={src} alt="" draggable={false} className="size-8 object-contain" />
              ))
            ) : (
              <span className="text-xs text-muted-foreground">No preview</span>
            )}
          </span>
          <span className="w-full truncate text-sm">{option.name}</span>
          {option.limited && (
            <span className="text-xs text-muted-foreground">Your system’s. Din’s apps keep their icons.</span>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={selected} onSelect={onChoose}>
          <Check aria-hidden />
          Use these icons
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
