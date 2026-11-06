import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileArchive, FolderOpen, MoreHorizontal, Puzzle, RotateCw, Share, Store, Trash2 } from 'lucide-react';
import { SectionHeader } from '@/components/desktop/apps/appstore/common';
import { PublishThemePackage, type PublishTarget } from '@/components/desktop/apps/PublishThemePackage';
import { UserscriptsSection } from '@/components/desktop/apps/UserscriptManager';
import { Badge } from '@/components/ui/badge';
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
import { useFilePicker } from '@/contexts/FilePickerContext';
import { CRX_EXTENSIONS_KEY, useCrxExtensions } from '@/hooks/useThemePackages';
import { useToast } from '@/hooks/useToast';
import { crxIconUrl, getCrxBridge, type CrxExtension } from '@/lib/crx';
import type { Userscript } from '@/lib/userscripts';
import { ToolButton } from '@/shared/appChrome';

/** Where the Chrome Web Store's extensions come from. */
const WEB_STORE_URL = 'https://chromewebstore.google.com/';

/** What each source of an extension is called on its row. */
const SOURCE_LABEL: Partial<Record<CrxExtension['source'], string>> = { local: 'Folder', file: 'File', nostr: 'Nostr' };

/** What about:extensions needs from the browser window hosting it, beyond the catalog. */
export interface InstalledExtensionsProps {
  /** Open a URL in a new tab (the Chrome Web Store). */
  onOpenUrl: (url: string) => void;
  /** Show a just-published extension's page, by its naddr. */
  onViewPublished: (naddr: string) => void;
  /** The userscript library, or null when the bridge is absent. */
  userscripts: Userscript[] | null;
  onSetUserscriptEnabled: (id: string, enabled: boolean) => void;
  onRemoveUserscript: (script: Userscript) => void;
  onAddUserscript: () => void;
}

/**
 * The top of about:extensions: the extensions installed in the browser, from
 * the Chrome Web Store, a folder, a .crx file or Nostr, each of which can be
 * reloaded (a folder's), published to Nostr or removed from its ⋯ menu or by
 * right-clicking it; buttons to add one from a folder, a .crx file or the
 * Web Store; and the userscript library.
 */
export function InstalledExtensions({
  onOpenUrl,
  onViewPublished,
  userscripts,
  onSetUserscriptEnabled,
  onRemoveUserscript,
  onAddUserscript,
}: InstalledExtensionsProps) {
  const crx = getCrxBridge();
  const { toast } = useToast();
  const { pickFile } = useFilePicker();
  const queryClient = useQueryClient();
  const { data: extensions } = useCrxExtensions();
  const [publishing, setPublishing] = useState<PublishTarget | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: CRX_EXTENSIONS_KEY });

  const uninstall = async (extension: CrxExtension) => {
    if (!crx) return;
    try {
      await crx.uninstallExtension(extension.id);
      toast({ title: `${extension.name} removed` });
    } catch (error) {
      toast({ title: `Couldn’t remove ${extension.name}`, description: cleanError(error), variant: 'destructive' });
    }
    refresh();
  };

  const reload = async (extension: CrxExtension) => {
    if (!crx) return;
    try {
      await crx.reloadExtension(extension.id);
      toast({ title: `${extension.name} reloaded` });
    } catch (error) {
      toast({ title: `Couldn’t reload ${extension.name}`, description: cleanError(error), variant: 'destructive' });
    }
    refresh();
  };

  const loadFolder = async () => {
    if (!crx) return;
    const folder = await pickFile({ title: 'Load an extension from a folder', confirmLabel: 'Load', directory: true }).catch(() => null);
    if (!folder) return;
    try {
      const extension = await crx.loadUnpacked(folder);
      toast({ title: `${extension.name} loaded` });
    } catch (error) {
      toast({ title: 'Couldn’t load that extension', description: cleanError(error), variant: 'destructive' });
    }
    refresh();
  };

  const installFile = async () => {
    if (!crx) return;
    const file = await pickFile({ title: 'Install an extension file', confirmLabel: 'Install', extensions: ['.crx'] }).catch(() => null);
    if (!file) return;
    try {
      const extension = await crx.installFile(file);
      toast({ title: `${extension.name} installed` });
    } catch (error) {
      toast({ title: 'Couldn’t install that extension', description: cleanError(error), variant: 'destructive' });
    }
    refresh();
  };

  const actions = (extension: CrxExtension): ExtensionAction[] => [
    ...(extension.source === 'local'
      ? [{ label: 'Reload', icon: <RotateCw />, run: () => void reload(extension) }]
      : []),
    {
      label: 'Publish to Nostr…',
      icon: <Share />,
      run: () => setPublishing({ type: 'extension', id: extension.id, name: extension.name, summary: extension.description }),
    },
    { label: 'Remove', icon: <Trash2 />, run: () => void uninstall(extension), destructive: true },
  ];

  return (
    <>
      {crx && (
        <section className="flex flex-col gap-4" aria-label="Installed">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <SectionHeader title="Installed" subtitle="Extensions run on the sites you browse in this app." />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void loadFolder()}>
                <FolderOpen aria-hidden />
                Load Folder…
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void installFile()}>
                <FileArchive aria-hidden />
                Install .crx File…
              </Button>
              <Button variant="secondary" size="sm" onClick={() => onOpenUrl(WEB_STORE_URL)}>
                <Store aria-hidden />
                Chrome Web Store
              </Button>
            </div>
          </div>
          {extensions == null ? null : extensions.length === 0 ? (
            <p className="rounded-2xl px-4 py-6 text-center text-sm text-muted-foreground">
              No extensions installed yet. Get one below, or add your own.
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 @2xl:grid-cols-2 @7xl:grid-cols-3">
              {extensions.map((extension) => (
                <ContextMenu key={extension.id}>
                  <ContextMenuTrigger asChild>
                    <li className="flex items-center gap-3 rounded-xl bg-card clay p-3">
                      <ExtensionIcon id={extension.id} />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          <span className="truncate">{extension.name}</span>
                          {SOURCE_LABEL[extension.source] && (
                            <Badge variant="secondary" className="shrink-0">{SOURCE_LABEL[extension.source]}</Badge>
                          )}
                        </p>
                        <p className="truncate text-xs text-muted-foreground" title={extension.path}>
                          {extension.path ? `${extension.version} · ${extension.path}` : extension.version}
                        </p>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <ToolButton size="sm" label={`More for ${extension.name}`}>
                            <MoreHorizontal className="size-4.5" strokeWidth={1.75} aria-hidden />
                          </ToolButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          {actions(extension).map((action) => (
                            <ExtensionMenuItem key={action.label} action={action} kind="dropdown" />
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </li>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-52">
                    {actions(extension).map((action) => (
                      <ExtensionMenuItem key={action.label} action={action} kind="context" />
                    ))}
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </ul>
          )}
        </section>
      )}

      {userscripts !== null && (
        <section aria-label="Userscripts">
          <UserscriptsSection
            scripts={userscripts}
            onSetEnabled={onSetUserscriptEnabled}
            onRemove={onRemoveUserscript}
            onAdd={onAddUserscript}
          />
        </section>
      )}

      <PublishThemePackage
        target={publishing}
        onClose={() => setPublishing(null)}
        onView={{ label: 'View in Extensions', open: onViewPublished }}
      />
    </>
  );
}

interface ExtensionAction {
  label: string;
  icon: ReactNode;
  run: () => void;
  destructive?: boolean;
}

/** One of an extension's actions, in its ⋯ menu or its right-click menu, with a line above Remove. */
function ExtensionMenuItem({ action, kind }: { action: ExtensionAction; kind: 'dropdown' | 'context' }) {
  const Item = kind === 'dropdown' ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === 'dropdown' ? DropdownMenuSeparator : ContextMenuSeparator;
  return (
    <>
      {action.destructive && <Separator />}
      <Item variant={action.destructive ? 'destructive' : 'default'} onSelect={action.run}>
        {action.icon}
        {action.label}
      </Item>
    </>
  );
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

/** Extension icon via the crx:// protocol, with a glyph fallback. */
function ExtensionIcon({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground/10 text-foreground/75 clay">
        <Puzzle className="size-4.5" strokeWidth={1.75} aria-hidden />
      </span>
    );
  }
  return (
    <img
      src={crxIconUrl(id, 32)}
      alt=""
      aria-hidden
      className="size-9 shrink-0 rounded-lg"
      onError={() => setFailed(true)}
    />
  );
}
