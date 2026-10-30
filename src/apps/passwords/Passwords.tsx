import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, KeyRound, Lock, PanelLeft, Plus, Search, StickyNote } from 'lucide-react';
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { cleanPasswordsError, type CopyField, type PasswordItem, type PasswordList, type PasswordsState, type PasswordSummary } from '@/lib/passwords';
import type { LaunchContext } from '@/sdk';
import { useDin, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { ItemDetail } from './passwords/ItemDetail';
import { ItemEditor } from './passwords/ItemEditor';
import { ItemIcon } from './passwords/ItemIcon';
import { ItemMenuItems, type ItemActions } from './passwords/ItemActions';
import { LockScreen, SetupScreen } from './passwords/LockScreen';
import { SettingsDialog } from './passwords/SettingsDialog';
import { Sidebar } from './passwords/Sidebar';
import {
  blankItem,
  byTitle,
  displayTitle,
  itemsIn,
  matchesSearch,
  sectionTitle,
  siteHost,
  useBridge,
  useVaultEvents,
  useVaultList,
  useVaultState,
  type BlankItem,
  type Section,
} from './passwords/vault';

/** What a launch asks for: an item to show (the browser's "Open in Passwords"). */
function launchedItem({ params }: LaunchContext): string | null {
  return typeof params.item === 'string' ? params.item : null;
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
  useWindowTitle('Passwords');
  const bridge = useBridge();
  const { data: state, isLoading } = useVaultState();

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
    body = <SetupScreen />;
  } else if (state.locked) {
    body = <LockScreen />;
  } else {
    return (
      <div className="@container/passwords relative flex h-full w-full bg-background text-foreground">
        <Vault state={state} />
      </div>
    );
  }
  return (
    <div className="@container/passwords flex h-full w-full flex-col bg-background text-foreground">
      <TitleBar />
      {body}
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
  const din = useDin();
  const bridge = useBridge()!;
  const { data: list } = useVaultList(true);
  const [section, setSection] = useState<Section>({ type: 'all' });
  const [chosen, setSelected] = useState<string | null>(() => launchedItem(din.app.launch));
  const [editing, setEditing] = useState<Editing>(null);
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
  const [folderPrompt, setFolderPrompt] = useState<FolderPrompt>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(
    () =>
      din.app.onLaunch((launch) => {
        const item = launchedItem(launch);
        if (!item) return;
        setSection({ type: 'all' });
        setSearch('');
        setEditing(null);
        setSelected(item);
      }),
    [din],
  );

  const items = useMemo(() => {
    if (!list) return [];
    return itemsIn(list, section)
      .filter((i) => matchesSearch(i, search))
      .sort(byTitle);
  }, [list, section, search]);

  // A selection that's gone (deleted for good) is let go.
  const selected = chosen && (!list || list.items.some((i) => i.id === chosen)) ? chosen : null;

  const notify = useCallback(
    (title: string, body?: string) => void din.notifications.show(title, { body, transient: true }),
    [din],
  );
  const fail = useCallback((err: unknown) => notify('Passwords couldn’t do that', cleanPasswordsError(err)), [notify]);

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
            notify(
              typeof field === 'string' ? copied[field] : `${field.field} copied`,
              field === 'password' || field === 'otp' ? 'It’s taken off the clipboard in 90 seconds.' : undefined,
            ),
          fail,
        ),
      openUrl: (url: string) => void din.app.openUrl(url),
      edit: (id: string) => {
        setSelected(id);
        void bridge.get(id).then((initial) => setEditing({ initial }), fail);
      },
      setFavorite: (id: string, favorite: boolean) => void bridge.setFavorite(id, favorite).catch(fail),
      move: (id: string, groupId: string) => void bridge.move(id, groupId).catch(fail),
      trash: (id: string) => void bridge.trash(id).catch(fail),
      restore: (id: string) => void bridge.restore(id).catch(fail),
      deleteForever: (id: string) => setDeleting(id),
    };
  }, [bridge, din, notify, fail]);

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

  const folderName = (id: string | null) => list?.groups.find((g) => g.id === id)?.name ?? '';
  const folderCount = (id: string) => (list ? itemsIn(list, { type: 'folder', id }).length : 0);

  return (
    <>
      <div className="flex h-full w-full" onKeyDownCapture={onKeyDown}>
        {list && (
          <Sidebar
            list={list}
            section={section}
            onSection={selectSection}
            onNewFolder={() => setFolderPrompt({ mode: 'new' })}
            onRenameFolder={(id) => setFolderPrompt({ mode: 'rename', id, name: folderName(id) })}
            onDeleteFolder={(id) => (folderCount(id) > 0 ? setDeletingFolder(id) : void bridge.deleteGroup(id).catch(fail))}
            onEmptyTrash={() => setEmptying(true)}
            onSettings={() => setSettingsOpen(true)}
            onLock={() => void bridge.lock()}
            className={cn(
              sidebarOpen ? 'absolute inset-y-0 left-0 z-30 flex bg-background shadow-xl' : 'hidden',
              '@3xl/passwords:static @3xl/passwords:flex @3xl/passwords:bg-muted/40 @3xl/passwords:shadow-none',
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

        <section
          aria-label={sectionTitle(section, list)}
          className={cn(
            'flex min-w-0 flex-1 flex-col border-r border-border/60 @2xl/passwords:w-72 @2xl/passwords:flex-none',
            showDetail && 'hidden @2xl/passwords:flex',
          )}
        >
          <WindowDragRegion className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-3">
            <Button
              variant="ghost"
              size="icon"
              className="size-8 @3xl/passwords:hidden"
              aria-label="Show the sidebar"
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeft className="size-4" />
            </Button>
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{sectionTitle(section, list)}</h1>
            {section.type === 'trash' ? (
              <Button variant="ghost" size="sm" disabled={items.length === 0} onClick={() => setEmptying(true)}>
                Delete All
              </Button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8" aria-label="New item" title="New item (Ctrl+N)">
                    <Plus className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => startNew('login')}>
                    <KeyRound className="size-4" aria-hidden />
                    New Password
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => startNew('note')}>
                    <StickyNote className="size-4" aria-hidden />
                    New Secure Note
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <div className="@2xl/passwords:hidden">
              <WindowControls />
            </div>
          </WindowDragRegion>
          <div className="px-3 pb-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                ref={searchRef}
                type="search"
                aria-label="Search"
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    moveSelection(1);
                  }
                }}
                className="h-8 bg-muted/60 pl-8"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {!list ? (
              <ListSkeleton />
            ) : items.length === 0 ? (
              <EmptyList section={section} searching={!!search.trim()} onNew={startNew} />
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
          <TitleBar>
            <Button
              variant="ghost"
              size="sm"
              className="@2xl/passwords:hidden"
              onClick={() => {
                setEditing(null);
                setSelected(null);
              }}
            >
              <ChevronLeft className="size-4" aria-hidden />
              {sectionTitle(section, list)}
            </Button>
          </TitleBar>
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

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} state={state} />

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
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-primary text-primary-foreground' : 'hover:bg-foreground/10',
            )}
          >
            <ItemIcon item={item} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{displayTitle(item)}</span>
              <span className={cn('block truncate text-xs', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
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

function EmptyList({ section, searching, onNew }: { section: Section; searching: boolean; onNew: (kind: 'login' | 'note') => void }) {
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
    <div className="m-2 rounded-xl border border-dashed border-border px-4 py-10 text-center">
      <p className="mx-auto max-w-xs text-sm text-muted-foreground">{text}</p>
      {!searching && section.type !== 'trash' && section.type !== 'codes' && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => onNew(section.type === 'notes' ? 'note' : 'login')}>
          <Plus className="size-4" aria-hidden />
          {section.type === 'notes' ? 'New Secure Note' : 'New Password'}
        </Button>
      )}
    </div>
  );
}

function NothingSelected({ count, autoUnlock }: { count: number; autoUnlock: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <img src="/icons/apps/passwords.png" alt="" className="size-20 opacity-90" />
      <p className="text-lg font-medium">{count === 1 ? '1 item' : `${count} items`}</p>
      <p className="flex max-w-xs items-center gap-1.5 text-sm text-muted-foreground">
        <Lock className="size-3.5 shrink-0" aria-hidden />
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
