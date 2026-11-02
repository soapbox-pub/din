import { useState } from 'react';
import { Check, MoreHorizontal, Share, Store, Trash2 } from 'lucide-react';
import { GlyphTile } from '@/components/desktop/AppIcon';
import { PublishThemePackage, type PublishTarget } from '@/components/desktop/apps/PublishThemePackage';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useIconThemeStatus, useIconThemes, useSetIconTheme } from '@/hooks/useIconTheme';
import { useThemePackageActions } from '@/hooks/useThemePackages';
import { useToast } from '@/hooks/useToast';
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
 * everywhere, changed where Din can (DinOS, GNOME and the like). Themes can
 * be published to Nostr, and come from it through the App Store.
 */
export function IconThemePicker() {
  const status = useIconThemeStatus();
  const themes = useIconThemes();
  const setTheme = useSetIconTheme();
  const { remove } = useThemePackageActions();
  const { open } = useWindowActions();
  const { toast } = useToast();
  const [publishing, setPublishing] = useState<PublishTarget | null>(null);

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
  const findIcons = () => open('app-store', { tab: 'icons' });
  const removeTheme = (option: IconThemeInfo) => {
    remove('icon', option.id).catch((error: unknown) => {
      toast({
        title: `Couldn’t remove ${option.name}`,
        description: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : undefined,
        variant: 'destructive',
      });
    });
  };

  // Nothing to pick between: only Din's own icons are installed.
  if (themes.data.every((option) => option.id === DIN_ICON_THEME) && theme === DIN_ICON_THEME) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border px-8 py-12 text-center">
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          Din is using its own icons. Get icon themes from the App Store, or add one to ~/.local/share/icons.
        </p>
        <Button type="button" variant="secondary" size="sm" onClick={findIcons}>
          <Store aria-hidden />
          Find Icons
        </Button>
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
              onPublish={() => setPublishing({ type: 'icon', id: option.id, name: option.name })}
              onRemove={() => removeTheme(option)}
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={findIcons}>
          <Store aria-hidden />
          Find Icons
        </Button>
      </div>
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
      <PublishThemePackage target={publishing} onClose={() => setPublishing(null)} />
    </div>
  );
}

/**
 * One theme in the picker. Its ⋯ and right-click menus can use it and
 * publish it to Nostr; one Din installed can also be removed. Din's own
 * icons aren't a theme to publish.
 */
function IconThemeOption({
  option,
  selected,
  disabled,
  onChoose,
  onPublish,
  onRemove,
}: {
  option: IconThemeInfo;
  selected: boolean;
  disabled: boolean;
  onChoose: () => void;
  onPublish: () => void;
  onRemove: () => void;
}) {
  const din = option.id === DIN_ICON_THEME;
  const preview = din ? DIN_PREVIEW : option.preview;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled}>
        <div className="relative">
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
              !din && 'pr-10',
              selected
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border/60 text-muted-foreground enabled:hover:bg-foreground/5 enabled:hover:text-foreground',
            )}
          >
            <span className="flex h-10 items-center gap-2" aria-hidden>
              {preview.length > 0 ? (
                preview.map((src) =>
                  option.monochrome ? (
                    <GlyphTile key={src} src={src} className="size-8" />
                  ) : (
                    <img key={src} src={src} alt="" draggable={false} className="size-8 object-contain" />
                  ),
                )
              ) : (
                <span className="text-xs text-muted-foreground">No preview</span>
              )}
            </span>
            <span className="w-full truncate text-sm">{option.name}</span>
            {option.limited && (
              <span className="text-xs text-muted-foreground">Your system’s. Din’s apps keep their icons.</span>
            )}
          </button>
          {!din && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1 size-8 text-muted-foreground"
                  aria-label={`More for ${option.name}`}
                >
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={selected || disabled} onSelect={onChoose}>
                  <Check aria-hidden />
                  Use these icons
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onPublish}>
                  <Share aria-hidden />
                  Publish to Nostr…
                </DropdownMenuItem>
                {option.imported && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" disabled={disabled} onSelect={onRemove}>
                      <Trash2 aria-hidden />
                      Remove
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={selected} onSelect={onChoose}>
          <Check aria-hidden />
          Use these icons
        </ContextMenuItem>
        {!din && (
          <ContextMenuItem onSelect={onPublish}>
            <Share aria-hidden />
            Publish to Nostr…
          </ContextMenuItem>
        )}
        {option.imported && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 aria-hidden />
              Remove
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
