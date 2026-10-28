import { useState, type ReactNode } from 'react';
import { Check, Copy, MoreHorizontal, Paintbrush, Pencil, Store, Trash2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ThemeSwatch } from '@/components/desktop/ThemeSwatch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { useAuthor } from '@/hooks/useAuthor';
import { useDesktopThemeEditor } from '@/hooks/useDesktopTheme';
import { useToast } from '@/hooks/useToast';
import { useThemeActions, useThemeLibrary } from '@/hooks/useThemes';
import { sameThemeLook } from '@/lib/profileTheme';
import { themeCoordinate, themeNaddr, type ThemeDefinition } from '@/lib/themeDefinition';
import { cn } from '@/lib/utils';

interface ThemeAction {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
  separated?: boolean;
}

/**
 * Settings → Appearance's "Your themes": the named themes the user has
 * published (kind 36767) and the ones they've added from the App Store.
 * Picking one wears it at once; the one worn is checked.
 */
export function YourThemes({ onEdit }: { onEdit: () => void }) {
  const library = useThemeLibrary();
  const { open } = useWindowActions();
  const themes = [...library.own, ...library.added];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">Your themes</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => open('app-store', { tab: 'themes' })}
        >
          <Store aria-hidden />
          Find Themes
        </Button>
      </div>
      {library.isLoading && themes.length === 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-lg border">
              <Skeleton className="aspect-video rounded-none" />
              <div className="p-2">
                <Skeleton className="h-4 w-3/5" />
              </div>
            </div>
          ))}
        </div>
      ) : themes.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-8 text-center">
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            Themes you save from a custom theme, and ones you get in the App Store, show up here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
          {themes.map((theme) => (
            <ThemeTile key={themeCoordinate(theme)} theme={theme} onEdit={onEdit} />
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeTile({ theme, onEdit }: { theme: ThemeDefinition; onEdit: () => void }) {
  const editor = useDesktopThemeEditor();
  const actions = useThemeActions();
  const { open } = useWindowActions();
  const { toast } = useToast();
  const own = actions.isOwn(theme);
  const author = useAuthor(own ? undefined : theme.pubkey);
  const authorName = (author.data?.metadata?.display_name || author.data?.metadata?.name)?.trim();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const worn =
    !!editor.theme &&
    editor.theme.source?.pubkey === theme.pubkey &&
    editor.theme.source.identifier === theme.identifier &&
    sameThemeLook(editor.theme, theme.theme);

  const apply = () => {
    try {
      editor.apply(theme.theme);
    } catch (error) {
      toast({
        title: 'Couldn’t use this theme',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
      return false;
    }
    return true;
  };

  const items: ThemeAction[] = [
    { label: 'Use Theme', icon: Paintbrush, onSelect: apply },
    ...(own
      ? [
          {
            label: 'Edit',
            icon: Pencil,
            onSelect: () => {
              if (apply()) onEdit();
            },
          },
        ]
      : []),
    {
      label: 'Show in App Store',
      icon: Store,
      onSelect: () => open('app-store', { theme: themeNaddr(theme) }),
      separated: true,
    },
    {
      label: 'Copy Address',
      icon: Copy,
      onSelect: () => {
        void navigator.clipboard
          .writeText(themeNaddr(theme))
          .then(() => toast({ title: 'Address copied' }));
      },
    },
    own
      ? {
          label: 'Delete…',
          icon: Trash2,
          onSelect: () => setConfirmingDelete(true),
          destructive: true,
          separated: true,
        }
      : {
          label: 'Remove from My Themes',
          icon: X,
          onSelect: () => actions.removeFromLibrary(theme),
          destructive: true,
          separated: true,
        },
  ];

  const remove = async () => {
    try {
      await actions.remove(theme);
      toast({ title: `${theme.title} deleted` });
    } catch (error) {
      toast({
        title: 'Couldn’t delete the theme',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'group relative overflow-hidden rounded-lg border bg-card',
              worn ? 'border-primary ring-1 ring-primary' : 'border-border/60',
            )}
          >
            <button
              type="button"
              onClick={apply}
              aria-pressed={worn}
              aria-label={`Use ${theme.title}`}
              className="absolute inset-0 z-[1] rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <ThemeSwatch theme={theme.theme} className="border-b border-border/60" />
            {worn && (
              <span className="absolute left-2 top-2 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground shadow">
                <Check className="size-3.5" aria-hidden />
              </span>
            )}
            <div className="flex items-center gap-1 py-1.5 pl-2.5 pr-1">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={theme.title}>
                  {theme.title}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {own ? 'Yours' : authorName ? `by ${authorName}` : 'Added'}
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`More actions for ${theme.title}`}
                    className="relative z-[2] grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <MoreHorizontal className="size-4" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  {items.map((item) => (
                    <MenuItem key={item.label} item={item} kind="dropdown" />
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          {items.map((item) => (
            <MenuItem key={item.label} item={item} kind="context" />
          ))}
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{theme.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This asks your relays to delete the theme. Anyone who already added it may keep a
              copy, and anyone wearing it keeps wearing it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void remove()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function MenuItem({ item, kind }: { item: ThemeAction; kind: 'dropdown' | 'context' }): ReactNode {
  const Item = kind === 'dropdown' ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === 'dropdown' ? DropdownMenuSeparator : ContextMenuSeparator;
  return (
    <>
      {item.separated && <Separator />}
      <Item variant={item.destructive ? 'destructive' : 'default'} onSelect={item.onSelect}>
        <item.icon aria-hidden />
        {item.label}
      </Item>
    </>
  );
}
