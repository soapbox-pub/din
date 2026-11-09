import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, FileUp, KeyRound, Lock, PanelLeft, Plus, StickyNote } from 'lucide-react';
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
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { cleanPasswordsError, type CopyField, type PasswordItem, type PasswordList, type PasswordsState, type PasswordSummary } from '@/lib/passwords';
import { useOnLaunch, windowLaunch, type Launch } from '@/shared/launch';
import { useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { toast } from '@/shared/toast';
import { ContentPane, SearchField, ToolButton } from '@/shared/appChrome';
import { flushPane, focusRing, listRowClass, titleSearch, toolIcon } from '@/shared/appChromeStyles';
import { ImportWindow } from './passwords/ImportWindow';
import { ItemDetail } from './passwords/ItemDetail';
import { ItemEditor } from './passwords/ItemEditor';
import { ItemIcon } from './passwords/ItemIcon';
import { ItemMenuItems, type ItemActions } from './passwords/ItemActions';
import { LockScreen, SetupScreen } from './passwords/LockScreen';
import { SettingsWindow } from './passwords/SettingsWindow';
import { Sidebar } from './passwords/Sidebar';
import {
  blankItem,
  byTitle,
  displayTitle,
  itemsIn,
  matchesSearch,
  sectionTitle,
  siteHost,
  openPasswordsWindow,
  useBridge,
  useImported,
  useVaultEvents,
  useVaultList,
  useVaultState,
  type BlankItem,
  type PasswordsWindow,
  type Section,
} from './passwords/vault';
import { bundledIconProps } from '@/shared/iconSizes';

/** What a launch asks for: an item to show (the browser's "Open in Passwords"). */
function launchedItem({ params }: Launch): string | null {
  return typeof params.item === 'string' ? params.item : null;
}

function windowKind({ params }: Launch): PasswordsWindow | null {
  return params.window === 'settings' || params.window === 'import' ? params.window : null;
}

function TitleBar({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <WindowDragRegion className={cn('flex h-12 shrink-0 items-center gap-2 px-3', className)}>
      {children}
      <div className="flex-1" />
      <WindowControls />
    </WindowDragRegion>
  );
}

/**
 * Passwords - Din's password manager, in the manner of Apple's Passwords
 * and 1Password: sections and folders down the side, the items in one, and
 * the one picked, whose fields copy with a click.
 *
 * The vault is Electron main's (din.system.passwords, the `passwords`
 * permission; electron/passwords.mts): a KeePass file that opens at login
 * from the login keyring. The Web Browser fills its logins in and offers to
 * save new ones; this is where they're seen and edited. Launch params
 * `{ item?: string }` show an item.
 */
export function Passwords() {
  useVaultEvents();
  const bridge = useBridge();
  const { data: state, isLoading } = useVaultState();
  // A window opened for the app's settings or an import, rather than the vault.
  const [kind] = useState(() => windowKind(windowLaunch()));
  useWindowTitle(kind === 'settings' ? 'Passwords Settings' : kind === 'import' ? 'Import Passwords' : 'Passwords');

  let body: React.ReactNode;
  if (!bridge) {
    body = <p className="m-auto max-w-sm p-8 text-center text-sm text-muted-foreground">Passwords works in Din’s desktop app.</p>;
  } else if (isLoading || !state) {
    body = (
      <div className="m-auto space-y-3">
        <Skeleton className="mx-auto size-24 rounded-3xl" />
        <Skeleton className="h-6 w-56" />
      </div>
    );
  } else if (!state.exists) {
    body = <SetupScreen computerPassword={state.computerPassword} />;
  } else if (state.locked) {
    body = <LockScreen />;
  } else if (kind === 'settings') {
    return <SettingsWindow state={state} />;
  } else if (kind === 'import') {
    return <ImportWindow />;
  } else {
    return (
      // No background of its own: the sidebar sits on the window's glass, and
      // the list and item on the solid pane beside it.
      <div className="@container/passwords relative flex h-full w-full text-foreground">
        <Vault state={state} />
      </div>
    );
  }
  return (
    <div className="@container/passwords flex h-full w-full flex-col text-foreground">
      <TitleBar />
      <ContentPane inset={false} className="border-t-0">
        {body}
      </ContentPane>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1 p-2">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2">
          <Skeleton className="size-8 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

type Editing = { initial: PasswordItem | BlankItem } | null;

/** A name typed for a new folder or a renamed one. */
type FolderPrompt = { mode: 'new' } | { mode: 'rename'; id: string; name: string } | null;

function Vault({ state }: { state: PasswordsState }) {
  const bridge = useBridge()!;
  const { data: list } = useVaultList(true);
  const [section, setSection] = useState<Section>({ type: 'all' });
  const [chosen, setSelected] = useState<string | null>(() => launchedItem(windowLaunch()));
  const [editing, setEditing] = useState<Editing>(null);
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [removingPasskey, setRemovingPasskey] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
  const [folderPrompt, setFolderPrompt] = useState<FolderPrompt>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useOnLaunch((launch) => {
    const item = launchedItem(launch);
    if (!item) return;
    setSection({ type: 'all' });
    setSearch('');
    setEditing(null);
    setSelected(item);
  });

  const items = useMemo(() => {
    if (!list) return [];
    return itemsIn(list, section)
      .filter((i) => matchesSearch(i, search))
      .sort(byTitle);
  }, [list, section, search]);

  // A selection that's gone (deleted for good) is let go.
  const selected = chosen && (!list || list.items.some((i) => i.id === chosen)) ? chosen : null;

  const fail = useCallback((err: unknown) => toast('Passwords couldn’t do that', { body: cleanPasswordsError(err), destructive: true }), []);

  const actions: ItemActions = useMemo(() => {
    const copied: Record<string, string> = {
      username: 'Username copied',
      password: 'Password copied',
      otp: 'Code copied',
      url: 'Website copied',
      notes: 'Note copied',
    };
    return {
      copy: (id: string, field: CopyField) =>
        void bridge.copy(id, field).then(
          () =>
            toast(typeof field === 'string' ? copied[field] : `${field.field} copied`, {
              body: field === 'password' || field === 'otp' ? 'It’s taken off the clipboard in 90 seconds.' : undefined,
            }),
          fail,
        ),
      openUrl: (url: string) => window.open(url),
      edit: (id: string) => {
        setSelected(id);
        void bridge.get(id).then((initial) => setEditing({ initial }), fail);
      },
      setFavorite: (id: string, favorite: boolean) => void bridge.setFavorite(id, favorite).catch(fail),
      move: (id: string, groupId: string) => void bridge.move(id, groupId).catch(fail),
      trash: (id: string) => void bridge.trash(id).catch(fail),
      restore: (id: string) => void bridge.restore(id).catch(fail),
      removePasskey: (id: string) => setRemovingPasskey(id),
      deleteForever: (id: string) => setDeleting(id),
    };
  }, [bridge, fail]);

  const startNew = useCallback(
    (kind: 'login' | 'note') => {
      if (!list) return;
      const groupId = section.type === 'folder' ? section.id : list.rootId;
      setEditing({ initial: { ...blankItem(kind, groupId), favorite: section.type === 'favorites' } });
    },
    [list, section],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchRef.current?.focus();
    } else if (mod && e.key.toLowerCase() === 'n' && !editing) {
      e.preventDefault();
      startNew('login');
    } else if (mod && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      void bridge.lock();
    }
  };

  const moveSelection = (delta: number) => {
    if (items.length === 0) return;
    const index = items.findIndex((i) => i.id === selected);
    const next = items[Math.max(0, Math.min(items.length - 1, index < 0 ? 0 : index + delta))];
    setEditing(null);
    setSelected(next.id);
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.focus();
  };

  const showDetail = !!selected || !!editing;
  const selectSection = (s: Section) => {
    setSection(s);
    setSearch('');
    setSelected(null);
    setEditing(null);
    setSidebarOpen(false);
  };
  // An import done in its window shows what came in.
  const selectRef = useRef(selectSection);
  useEffect(() => {
    selectRef.current = selectSection;
  });
  useImported(
    useCallback((result) => {
      if (result.added > 0) selectRef.current(result.folderId ? { type: 'folder', id: result.folderId } : { type: 'all' });
    }, []),
  );

  // New (or, in Recently Deleted, Delete All): beside the name in the
  // sidebar's title, or the search while the sidebar's hidden.
  const newItem = section.type === 'trash' ? (
    <Button variant="ghost" size="sm" disabled={items.length === 0} onClick={() => setEmptying(true)}>
      Delete All
    </Button>
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolButton label="New item" title="New item (Ctrl+N)">
          <Plus {...toolIcon} />
        </ToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => startNew('login')}>
          <KeyRound className="size-4.5" strokeWidth={1.75} aria-hidden />
          New Password
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => startNew('note')}>
          <StickyNote className="size-4.5" strokeWidth={1.75} aria-hidden />
          New Secure Note
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openPasswordsWindow('import')}>
          <FileUp className="size-4.5" strokeWidth={1.75} aria-hidden />
          Import Passwords…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const folderName = (id: string | null) => list?.groups.find((g) => g.id === id)?.name ?? '';
  const folderCount = (id: string) => (list ? itemsIn(list, { type: 'folder', id }).length : 0);

  return (
    <>
      <div className="relative flex h-full w-full" onKeyDownCapture={onKeyDown}>
        {/* The strip above the inset content still drags the window. */}
        <WindowDragRegion className="absolute inset-x-0 top-0 h-2" />
        {list && (
          <Sidebar
            list={list}
            section={section}
            onSection={selectSection}
            onNewFolder={() => setFolderPrompt({ mode: 'new' })}
            onRenameFolder={(id) => setFolderPrompt({ mode: 'rename', id, name: folderName(id) })}
            onDeleteFolder={(id) => (folderCount(id) > 0 ? setDeletingFolder(id) : void bridge.deleteGroup(id).catch(fail))}
            onEmptyTrash={() => setEmptying(true)}
            onSettings={() => openPasswordsWindow('settings')}
            onLock={() => void bridge.lock()}
            actions={newItem}
            className={cn(
              sidebarOpen ? 'absolute inset-y-0 left-0 z-30 flex bg-background shadow-xl' : 'hidden',
              '@3xl/passwords:static @3xl/passwords:flex @3xl/passwords:bg-transparent @3xl/passwords:shadow-none',
            )}
          />
        )}
        {sidebarOpen && (
          <button
            type="button"
            aria-label="Close the sidebar"
            className="absolute inset-0 z-20 bg-background/40 @3xl/passwords:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0">
            <WindowDragRegion
              className={cn(
                'flex h-12 min-w-0 flex-1 shrink-0 items-center gap-2 pr-3 pl-3',
                showDetail && 'hidden @2xl/passwords:flex',
              )}
            >
              <ToolButton label="Show the sidebar" className="@3xl/passwords:hidden" onClick={() => setSidebarOpen(true)}>
                <PanelLeft {...toolIcon} />
              </ToolButton>
              {/* The search across the title bar, as Mail's. */}
              <SearchField
                ref={searchRef}
                aria-label={`Search ${sectionTitle(section, list)}`}
                placeholder={`Search ${sectionTitle(section, list)}`}
                value={search}
                onValueChange={setSearch}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    moveSelection(1);
                  }
                }}
                className={titleSearch}
              />
              {/* With the sidebar showing, New is in its title. */}
              <div className="flex @3xl/passwords:hidden">{newItem}</div>
              <div className="min-w-2 flex-1" />
              <WindowControls />
            </WindowDragRegion>
            <TitleBar className={cn('min-w-0 flex-1 @2xl/passwords:hidden', !showDetail && 'hidden')}>
              <Button
                variant="ghost"
                size="sm"
                className="@2xl/passwords:hidden"
                onClick={() => {
                  setEditing(null);
                  setSelected(null);
                }}
              >
                <ChevronLeft className="size-4.5" strokeWidth={1.75} aria-hidden />
                {sectionTitle(section, list)}
              </Button>
            </TitleBar>
          </div>
          <div className={cn('flex min-h-0 min-w-0 flex-1 overflow-hidden border-t border-border/60 bg-background @3xl/passwords:mr-2 @3xl/passwords:mb-2 @3xl/passwords:rounded-2xl @3xl/passwords:border-t-0 @3xl/passwords:clay', flushPane)}>
          <section
            aria-label={sectionTitle(section, list)}
            className={cn(
              'relative flex min-w-0 flex-1 flex-col @2xl/passwords:w-72 @2xl/passwords:flex-none @2xl/passwords:after:absolute @2xl/passwords:after:inset-y-3 @2xl/passwords:after:right-0 @2xl/passwords:after:w-px @2xl/passwords:after:bg-border/70',
              showDetail && 'hidden @2xl/passwords:flex',
            )}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2">
              {!list ? (
                <ListSkeleton />
              ) : items.length === 0 ? (
                <EmptyList section={section} searching={!!search.trim()} onNew={startNew} onImport={() => openPasswordsWindow('import')} />
              ) : (
                <ul
                  ref={listRef}
                  className="space-y-0.5"
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
                    }
                  }}
                >
                  {items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      list={list}
                      active={item.id === selected}
                      onSelect={() => {
                        setEditing(null);
                        setSelected(item.id);
                      }}
                      actions={actions}
                    />
                  ))}
                </ul>
              )}
            </div>
          </section>

          <main className={cn('flex min-w-0 flex-1 flex-col', !showDetail && 'hidden @2xl/passwords:flex')}>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {list && editing ? (
                <ItemEditor
                  key={editing.initial.id ?? 'new'}
                  initial={editing.initial}
                  list={list}
                  onCancel={() => setEditing(null)}
                  onSaved={(id) => {
                    setEditing(null);
                    setSelected(id);
                  }}
                />
              ) : list && selected ? (
                <ItemDetail key={selected} id={selected} list={list} actions={actions} onEdit={(initial) => setEditing({ initial })} />
              ) : (
                <NothingSelected count={list?.items.filter((i) => !i.trashed).length ?? 0} autoUnlock={state.autoUnlock} />
              )}
            </div>
          </main>
          </div>
        </div>
      </div>

      <FolderDialog
        prompt={folderPrompt}
        onClose={() => setFolderPrompt(null)}
        onSubmit={(name) => {
          const prompt = folderPrompt;
          setFolderPrompt(null);
          if (prompt?.mode === 'rename') void bridge.renameGroup(prompt.id, name).catch(fail);
          else void bridge.createGroup(name, section.type === 'folder' ? section.id : undefined).then((id) => selectSection({ type: 'folder', id }), fail);
        }}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{displayTitle(list?.items.find((i) => i.id === deleting) ?? { title: '', url: '' })}” now?</AlertDialogTitle>
            <AlertDialogDescription>It’s gone for good: this can’t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => deleting && void bridge.deleteForever(deleting).catch(fail)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removingPasskey !== null} onOpenChange={(open) => !open && setRemovingPasskey(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the passkey from “{displayTitle(list?.items.find((i) => i.id === removingPasskey) ?? { title: '', url: '' })}”?</AlertDialogTitle>
            <AlertDialogDescription>
              You can’t sign in with it anymore, here or in another app that opens this vault. The rest of the item stays. Remove it from your account on the site too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => removingPasskey && void bridge.removePasskey(removingPasskey).catch(fail)}
            >
              Remove Passkey
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={emptying} onOpenChange={setEmptying}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete everything in Recently Deleted?</AlertDialogTitle>
            <AlertDialogDescription>These items are gone for good: this can’t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void bridge.emptyTrash().catch(fail)}>
              Delete All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deletingFolder !== null} onOpenChange={(open) => !open && setDeletingFolder(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the folder “{folderName(deletingFolder)}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It and the {deletingFolder ? folderCount(deletingFolder) : 0} items in it go to Recently Deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (!deletingFolder) return;
                if (section.type === 'folder' && section.id === deletingFolder) selectSection({ type: 'all' });
                void bridge.deleteGroup(deletingFolder).catch(fail);
              }}
            >
              Delete Folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ItemRow({
  item,
  list,
  active,
  onSelect,
  actions,
}: {
  item: PasswordSummary;
  list: PasswordList;
  active: boolean;
  onSelect: () => void;
  actions: ItemActions;
}) {
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            data-id={item.id}
            onClick={onSelect}
            onFocus={onSelect}
            onDoubleClick={() => item.kind === 'login' && actions.copy(item.id, 'password')}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left',
              focusRing,
              listRowClass({ selected: active }),
            )}
          >
            <ItemIcon item={item} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{displayTitle(item)}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {item.kind === 'note' ? 'Secure note' : item.username || siteHost(item.url) || 'No username'}
              </span>
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ItemMenuItems kind="context" item={item} list={list} actions={actions} />
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

function EmptyList({
  section,
  searching,
  onNew,
  onImport,
}: {
  section: Section;
  searching: boolean;
  onNew: (kind: 'login' | 'note') => void;
  onImport: () => void;
}) {
  const text = searching
    ? 'Nothing matches that.'
    : section.type === 'trash'
      ? 'Deleted items stay here, so they can be put back.'
      : section.type === 'favorites'
        ? 'Items you add to Favorites appear here.'
        : section.type === 'codes'
          ? 'Logins with a verification code appear here. Add a site’s setup key to a login to keep its codes in Passwords.'
          : section.type === 'notes'
            ? 'Keep things like recovery codes and Wi-Fi passwords in secure notes.'
            : 'Passwords you save in the Web Browser, or add here, appear in this list.';
  return (
    <div className="m-2 rounded-xl px-4 py-10 text-center">
      <p className="mx-auto max-w-xs text-sm text-muted-foreground">{text}</p>
      {!searching && section.type !== 'trash' && section.type !== 'codes' && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => onNew(section.type === 'notes' ? 'note' : 'login')}>
          <Plus className="size-4.5" strokeWidth={1.75} aria-hidden />
          {section.type === 'notes' ? 'New Secure Note' : 'New Password'}
        </Button>
      )}
      {!searching && section.type === 'all' && (
        <Button variant="ghost" size="sm" className="mt-2 ml-2" onClick={onImport}>
          <FileUp className="size-4.5" strokeWidth={1.75} aria-hidden />
          Import…
        </Button>
      )}
    </div>
  );
}

function NothingSelected({ count, autoUnlock }: { count: number; autoUnlock: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <img {...bundledIconProps('/icons/apps/passwords.png')} alt="" className="size-20 opacity-90" />
      <p className="text-lg font-medium">{count === 1 ? '1 item' : `${count} items`}</p>
      <p className="flex max-w-xs items-center gap-1.5 text-sm text-muted-foreground">
        <Lock className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
        {autoUnlock ? 'Unlocks when you sign in to this computer.' : 'Asks for its password each time.'}
      </p>
    </div>
  );
}

function FolderDialog({
  prompt,
  onClose,
  onSubmit,
}: {
  prompt: FolderPrompt;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        {prompt && <FolderForm key={prompt.mode === 'rename' ? prompt.id : 'new'} prompt={prompt} onClose={onClose} onSubmit={onSubmit} />}
      </DialogContent>
    </Dialog>
  );
}

function FolderForm({
  prompt,
  onClose,
  onSubmit,
}: {
  prompt: NonNullable<FolderPrompt>;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(prompt.mode === 'rename' ? prompt.name : '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{prompt.mode === 'rename' ? 'Rename Folder' : 'New Folder'}</DialogTitle>
      </DialogHeader>
      <Input aria-label="Folder name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim()}>
          {prompt.mode === 'rename' ? 'Rename' : 'Create'}
        </Button>
      </DialogFooter>
    </form>
  );
}
