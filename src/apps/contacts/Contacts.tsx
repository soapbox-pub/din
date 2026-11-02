import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookUser, ChevronLeft, FileUp, PanelLeft, Plus, Smartphone, UserPlus, Users } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import type { LaunchContext } from '@/sdk/din';
import { useDin, useMenuBar, useWindowState, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import {
  addGroup,
  changeGroup,
  contactFromPhone,
  deleteContacts,
  importContacts,
  saveContact,
  setInGroup,
  type StoredContact,
} from '@/shared/contacts';
import { DialogButton, Overlay } from '@/shared/dialogs';
import { fileTypes, pickFiles, pickSaveFile, useLaunchFiles, writeFile } from '@/shared/fileHandles';
import { toast } from '@/shared/toast';
import {
  blankContact,
  compareContacts,
  contactMatches,
  displayName,
  numberDigits,
  parseVCards,
  samePerson,
  serializeVCards,
  type Contact,
  type PostalAddress,
  type SortBy,
} from '@/shared/vcard';
import { useAddressBook, useBookChange, usePhones } from './contacts/book';
import { ContactCard, type FieldActions } from './contacts/Card';
import { ContactEditor } from './contacts/Editor';
import { addressLines, cardText, vcardFileName } from './contacts/format';
import { ContactList, type ListItem } from './contacts/List';
import { contactMenu, phoneContactMenu, type ContactAction } from './contacts/menu';
import { CONTACT_DRAG, sameSource, type Source } from './contacts/model';
import { Sidebar } from './contacts/Sidebar';

const SORT_KEY = 'din:contacts:sort';
const SIDEBAR_KEY = 'din:contacts:sidebar';
const SIDEBAR_MIN_WIDTH = 860;
const TWO_PANE_MIN_WIDTH = 620;
const VCARD_TYPES = fileTypes([{ description: 'vCards', extensions: ['.vcf', '.vcard'] }]);

interface Saved {
  source: Source;
  selected: string | null;
}

function isSource(v: unknown): v is Source {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<Record<'kind' | 'name' | 'id', unknown>>;
  return s.kind === 'all' || (s.kind === 'group' && typeof s.name === 'string') || (s.kind === 'phone' && typeof s.id === 'string');
}

function savedOf(launch: LaunchContext): Saved | null {
  const s = launch.state as Partial<Saved> | null;
  return s && isSource(s.source) ? { source: s.source, selected: typeof s.selected === 'string' ? s.selected : null } : null;
}

/** An address book entry, or a phone's contact (read-only), as the list and card see it. */
interface Entry {
  key: string;
  contact: Contact;
  stored: StoredContact | null;
  phone: { id: string; name: string; inBook: StoredContact | null } | null;
}

/** Only links to the web open from a card; anything else is taken as a site's address. */
function webUrl(value: string): string {
  const v = value.trim();
  return /^https?:\/\//i.test(v) ? v : `https://${v.replace(/^[a-z][a-z0-9+.-]*:\/*/i, '')}`;
}

async function readCards(files: readonly FileSystemHandle[]): Promise<{ name: string; cards: Contact[] } | null> {
  const vcards = files.filter((h): h is FileSystemFileHandle => h.kind === 'file' && /\.(vcf|vcard)$/i.test(h.name));
  if (!vcards.length) return null;
  const cards: Contact[] = [];
  for (const h of vcards) cards.push(...parseVCards(await (await h.getFile()).text()));
  return { name: vcards.length === 1 ? vcards[0].name : `${vcards.length} files`, cards };
}

/**
 * Contacts: an address book kept as vCards in ~/.local/share/din/contacts
 * (src/shared/contacts.ts), with groups, import and export of .vcf files,
 * and the contacts the user's phones share (Settings → Phone) beside it,
 * read-only. Launch params `{ contact: uid }` show someone; the New Contact
 * shortcut starts one; a .vcf opened from Files is imported.
 */
export function Contacts() {
  const din = useDin();
  const fsAvailable = !!din.system.fs;
  const book = useAddressBook();
  const change = useBookChange();
  const { phones, contacts: phoneLists, loading: phonesLoading, ready: phonesReady } = usePhones();
  const canMessage = !!din.system.phone && phones.length > 0;

  const [saved] = useState(() => (din.app.launch.reason === 'restore' ? savedOf(din.app.launch) : null));
  const [picked, setSource] = useState<Source>(() => saved?.source ?? { kind: 'all' });
  const [selected, setSelected] = useState<string[]>(() => {
    const target = din.app.launch.params.contact;
    if (typeof target === 'string') return [target];
    return saved?.selected ? [saved.selected] : [];
  });
  const anchor = useRef<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortByState] = useState<SortBy>(() => (localStorage.getItem(SORT_KEY) === 'given' ? 'given' : 'family'));
  const [editor, setEditor] = useState<{ draft: Contact; was: StoredContact | null } | null>(() =>
    din.app.launch.shortcut === 'new-contact' && din.app.launch.reason !== 'restore' ? { draft: blankContact(), was: null } : null,
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<StoredContact[] | null>(null);
  const [naming, setNaming] = useState<{ from: string | null; name: string; add: StoredContact[] } | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<string | null>(null);
  const [importing, setImporting] = useState<{ name: string; cards: Contact[] } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== 'hidden');
  const width = useWindowState((s) => s.bounds.width || window.innerWidth);
  const sidebarFits = width >= SIDEBAR_MIN_WIDTH;
  const showSidebar = sidebarOpen && sidebarFits;
  const twoPanes = width >= TWO_PANE_MIN_WIDTH;

  const setSortBy = (by: SortBy) => {
    setSortByState(by);
    localStorage.setItem(SORT_KEY, by);
  };
  const toggleSidebar = (open: boolean) => {
    localStorage.setItem(SIDEBAR_KEY, open ? 'shown' : 'hidden');
    setSidebarOpen(open);
  };

  const contacts = useMemo(() => book.data?.contacts ?? [], [book.data]);
  const groups = useMemo(() => book.data?.groups ?? [], [book.data]);
  // A group or phone that's gone shows everyone instead.
  const gone =
    (picked.kind === 'group' && !!book.data && !groups.includes(picked.name)) ||
    (picked.kind === 'phone' && (!din.system.phone || (phonesReady && !phones.some((p) => p.id === picked.id))));
  const source = useMemo<Source>(() => (gone ? { kind: 'all' } : picked), [gone, picked]);

  // A phone's contact is in the address book when someone here has one of its numbers.
  const byNumber = useMemo(() => {
    const m = new Map<string, StoredContact>();
    for (const c of contacts) for (const p of c.phones) if (numberDigits(p.value)) m.set(numberDigits(p.value), c);
    return m;
  }, [contacts]);

  const entries = useMemo<Entry[]>(() => {
    if (source.kind === 'phone') {
      const phone = phones.find((p) => p.id === source.id);
      const seen = new Map<string, number>();
      return (phoneLists.get(source.id) ?? []).map((pc) => {
        const base = `phone:${source.id}:${pc.name}|${pc.numbers.join(',')}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const contact = { ...contactFromPhone(pc), uid: n ? `${base}#${n}` : base };
        const inBook = pc.numbers.map((x) => byNumber.get(numberDigits(x))).find(Boolean) ?? contacts.find((c) => samePerson(c, contact)) ?? null;
        return { key: contact.uid, contact, stored: null, phone: { id: source.id, name: phone?.name ?? 'Phone', inBook } };
      });
    }
    const list = source.kind === 'group' ? contacts.filter((c) => c.groups.includes(source.name)) : contacts;
    return list.map((c) => ({ key: c.uid, contact: c, stored: c, phone: null }));
  }, [source, contacts, phones, phoneLists, byNumber]);

  const items = useMemo<ListItem[]>(
    () => entries.filter((e) => contactMatches(e.contact, search)).sort((a, b) => compareContacts(a.contact, b.contact, sortBy)),
    [entries, search, sortBy],
  );
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const chosen = useMemo(() => selected.map((k) => byKey.get(k)).filter((e): e is Entry => !!e), [selected, byKey]);
  const chosenStored = useMemo(() => chosen.flatMap((e) => (e.stored ? [e.stored] : [])), [chosen]);
  const current = chosen.length === 1 ? chosen[0] : null;

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of contacts) for (const g of c.groups) m.set(g, (m.get(g) ?? 0) + 1);
    return m;
  }, [contacts]);
  const phoneCounts = useMemo(() => new Map([...phoneLists].map(([id, list]) => [id, list.length])), [phoneLists]);

  const sourceTitle = source.kind === 'all' ? 'All Contacts' : source.kind === 'group' ? source.name : phones.find((p) => p.id === source.id)?.name ?? 'Phone';
  useWindowTitle(editor ? (editor.was ? displayName(editor.was) || 'Edit Contact' : 'New Contact') : current ? displayName(current.contact) || 'No Name' : sourceTitle);

  useEffect(() => din.app.saveState({ source, selected: current?.key ?? null } satisfies Saved), [din, source, current]);

  const showSource = useCallback((s: Source) => {
    setSource(s);
    setSelected([]);
    setSearch('');
    setEditor(null);
  }, []);

  const showContact = useCallback((uid: string) => {
    setSource((s) => (s.kind === 'phone' ? { kind: 'all' } : s));
    setSearch('');
    setSelected([uid]);
    anchor.current = uid;
  }, []);

  const select = (key: string, how: { range: boolean; toggle: boolean }) => {
    if (editor) setEditor(null);
    if (how.toggle) {
      setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
      anchor.current = key;
      return;
    }
    if (how.range && anchor.current) {
      const from = items.findIndex((it) => it.key === anchor.current);
      const to = items.findIndex((it) => it.key === key);
      if (from >= 0 && to >= 0) {
        const span = items.slice(Math.min(from, to), Math.max(from, to) + 1).map((it) => it.key).filter((k) => k !== key);
        setSelected([...span, key]);
        return;
      }
    }
    setSelected([key]);
    anchor.current = key;
  };

  // ---- importing and exporting ----

  const offerImport = useCallback(async (files: readonly FileSystemHandle[]) => {
    try {
      const read = await readCards(files);
      if (!read) return;
      if (!read.cards.length) return toast('No contacts in that file', { body: `${read.name} has no vCards in it.`, destructive: true });
      setImporting(read);
    } catch (error) {
      toast('Couldn’t read the file', { body: error instanceof Error ? error.message : String(error), destructive: true });
    }
  }, []);

  useLaunchFiles((files) => void offerImport(files));

  const runImport = async (cards: Contact[]) => {
    const result = await change((fs) => importContacts(fs, cards, book.data), 'Couldn’t import the contacts');
    if (!result) return;
    const parts = [result.added && `${result.added} added`, result.merged && `${result.merged} updated`, result.unchanged && `${result.unchanged} already here`].filter(Boolean);
    toast(result.contacts.length === 1 ? `${displayName(result.contacts[0]) || 'Contact'} is in your contacts` : 'Contacts imported', { body: parts.join(', ') });
    setSource({ kind: 'all' });
    setSearch('');
    setEditor(null);
    setSelected(result.contacts.length ? [result.contacts[0].uid] : []);
  };

  const importFromFile = async () => {
    const files = await pickFiles({ types: VCARD_TYPES, multiple: true, mode: 'read', title: 'Import Contacts', confirmLabel: 'Import' });
    if (files.length) await offerImport(files);
  };

  const exportCards = async (list: readonly Contact[], name: string) => {
    if (!list.length) return;
    const target = await pickSaveFile({ suggestedName: vcardFileName(list, name), types: fileTypes([{ description: 'vCard', extensions: ['.vcf'] }]), title: 'Export Contacts' });
    if (!target) return;
    try {
      await writeFile(target, serializeVCards(list));
      toast(list.length === 1 ? 'vCard exported' : `${list.length} contacts exported`, { body: target.name });
    } catch (error) {
      toast('Couldn’t export', { body: error instanceof Error ? error.message : String(error), destructive: true });
    }
  };

  // ---- reaching people ----

  const fields: FieldActions = {
    message: canMessage
      ? (address: string) => {
          const name = current ? displayName(current.contact) : '';
          void din.app.open('messages', { to: [{ name: name || address, address }], nonce: Date.now() });
        }
      : undefined,
    email: (address) => void window.open(`mailto:${address}`),
    openUrl: (url) => void window.open(webUrl(url)),
    map: (a: PostalAddress) => void window.open(`https://www.openstreetmap.org/search?query=${encodeURIComponent(addressLines(a).replace(/\n/g, ', '))}`),
    copy: (text, what) => {
      void navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    },
  };

  // ---- acting on contacts ----

  const act = (targets: Entry[], action: ContactAction) => {
    const stored = targets.flatMap((e) => (e.stored ? [e.stored] : []));
    const one = targets.length === 1 ? targets[0] : null;
    if (action.startsWith('group:')) {
      const group = action.slice('group:'.length);
      const inIt = stored.every((c) => c.groups.includes(group));
      void change((fs) => setInGroup(fs, stored, group, !inIt), 'Couldn’t change the group');
      return;
    }
    switch (action) {
      case 'edit':
        if (one?.stored) setEditor({ draft: one.stored, was: one.stored });
        return;
      case 'message':
        if (one?.contact.phones[0] && canMessage) {
          const address = one.contact.phones[0].value;
          void din.app.open('messages', { to: [{ name: displayName(one.contact) || address, address }], nonce: Date.now() });
        }
        return;
      case 'email':
        if (one?.contact.emails[0]) fields.email(one.contact.emails[0].value);
        return;
      case 'copy':
        void navigator.clipboard.writeText(targets.map((e) => cardText(e.contact)).join('\n\n'));
        toast(targets.length === 1 ? 'Card copied' : 'Cards copied');
        return;
      case 'export':
        void exportCards(targets.map((e) => e.contact), sourceTitle);
        return;
      case 'delete':
        if (stored.length) setDeleting(stored);
        return;
      case 'add':
        if (one) void runImport([one.contact]);
        return;
      case 'show':
        if (one?.phone?.inBook) showContact(one.phone.inBook.uid);
        return;
      case 'new-group':
        setNaming({ from: null, name: '', add: stored });
        return;
    }
  };

  const menuOf = (targets: Entry[]) => {
    const one = targets.length === 1 ? targets[0] : null;
    if (one?.phone) return phoneContactMenu(one.contact, !!one.phone.inBook, { message: canMessage });
    return contactMenu(targets.flatMap((e) => (e.stored ? [e.stored] : [])), groups, { message: canMessage });
  };
  /** A row acts on the selection when it's part of it, else on itself. */
  const rowTargets = (key: string): Entry[] => (selected.includes(key) && chosen.length > 1 ? chosen : [byKey.get(key)].filter((e): e is Entry => !!e));

  const newContact = () => {
    const draft = blankContact();
    if (source.kind === 'group') draft.groups = [source.name];
    if (source.kind === 'phone') setSource({ kind: 'all' });
    setEditor({ draft, was: null });
  };

  const save = async (draft: Contact) => {
    if (saving) return;
    setSaving(true);
    const was = editor?.was ?? undefined;
    const stored = await change((fs) => saveContact(fs, draft, was), was ? 'Couldn’t save the contact' : 'Couldn’t add the contact');
    setSaving(false);
    if (!stored) return;
    setEditor(null);
    if (source.kind === 'group' && !stored.groups.includes(source.name)) setSource({ kind: 'all' });
    setSearch('');
    setSelected([stored.uid]);
    anchor.current = stored.uid;
  };

  const remove = async (list: StoredContact[]) => {
    await change((fs) => deleteContacts(fs, list), list.length === 1 ? 'Couldn’t delete the contact' : 'Couldn’t delete the contacts');
    setSelected([]);
    toast(list.length === 1 ? `${displayName(list[0]) || 'Contact'} deleted` : `${list.length} contacts deleted`);
  };

  const saveGroup = async () => {
    if (!naming) return;
    const name = naming.name.trim();
    if (!name) return;
    if (naming.from !== null) {
      if (name !== naming.from && groups.includes(name)) return toast('There’s a group with that name', { destructive: true });
      await change((fs) => changeGroup(fs, naming.from!, name), 'Couldn’t rename the group');
      if (source.kind === 'group' && source.name === naming.from) setSource({ kind: 'group', name });
    } else {
      const add = naming.add;
      await change(async (fs) => {
        await addGroup(fs, name);
        if (add.length) await setInGroup(fs, add, name, true);
      }, 'Couldn’t make the group');
      if (!add.length) showSource({ kind: 'group', name });
    }
    setNaming(null);
  };

  const deleteGroup = async (name: string) => {
    await change((fs) => changeGroup(fs, name, null), 'Couldn’t delete the group');
    if (source.kind === 'group' && source.name === name) showSource({ kind: 'all' });
    toast(`${name} deleted`, { body: 'The people in it are still in your contacts.' });
  };

  const dropOnGroup = (group: string, keys: string[]) => {
    const list = keys.map((k) => contacts.find((c) => c.uid === k)).filter((c): c is StoredContact => !!c && !c.groups.includes(group));
    if (!list.length) return;
    void change((fs) => setInGroup(fs, list, group, true), 'Couldn’t add them to the group').then(() =>
      toast(list.length === 1 ? `${displayName(list[0]) || 'Contact'} added to ${group}` : `${list.length} contacts added to ${group}`),
    );
  };

  // Launched again (a link to someone, the shortcut).
  useEffect(
    () =>
      din.app.onLaunch((launch) => {
        if (typeof launch.params.contact === 'string') {
          setEditor(null);
          showContact(launch.params.contact);
        }
        if (launch.shortcut === 'new-contact') setEditor({ draft: blankContact(), was: null });
      }),
    [din, showContact],
  );

  useMenuBar(
    [
      {
        label: 'File',
        items: [
          { id: 'new', label: 'New Contact', accelerator: 'Ctrl+N', enabled: fsAvailable },
          { id: 'new-group', label: 'New Group…', accelerator: 'Ctrl+Shift+N', enabled: fsAvailable },
          { type: 'separator' },
          { id: 'import', label: 'Import vCards…', accelerator: 'Ctrl+O', enabled: fsAvailable },
          { id: 'export', label: chosen.length ? (chosen.length === 1 ? 'Export vCard…' : `Export ${chosen.length} vCards…`) : `Export ${sourceTitle}…`, accelerator: 'Ctrl+Shift+E', enabled: chosen.length > 0 || items.length > 0 },
        ],
      },
      {
        label: 'Edit',
        items: [
          { id: 'edit', label: 'Edit Contact', accelerator: 'Ctrl+E', enabled: !!current?.stored && !editor },
          { id: 'select-all', label: 'Select All', accelerator: 'Ctrl+A', notInFields: true, enabled: items.length > 0 },
          { type: 'separator' },
          { id: 'delete', label: chosenStored.length > 1 ? `Delete ${chosenStored.length} Contacts…` : 'Delete Contact…', accelerator: 'Delete', notInFields: true, enabled: chosenStored.length > 0 && !editor, destructive: true },
        ],
      },
      {
        label: 'Contact',
        items: [
          { id: 'message', label: 'Send Message', enabled: canMessage && !!current?.contact.phones.length },
          { id: 'email', label: 'Send Email', enabled: !!current?.contact.emails.length },
          { id: 'copy', label: 'Copy Card', enabled: chosen.length > 0 },
          { type: 'separator' },
          { id: 'add', label: 'Add to My Contacts', enabled: !!current?.phone && !current.phone.inBook },
        ],
      },
      {
        label: 'View',
        items: [
          { id: 'sort:given', type: 'radio', group: 'sort', label: 'Sort by First Name', checked: sortBy === 'given' },
          { id: 'sort:family', type: 'radio', group: 'sort', label: 'Sort by Last Name', checked: sortBy === 'family' },
          { type: 'separator' },
          { id: 'sidebar', label: showSidebar ? 'Hide Sidebar' : 'Show Sidebar', enabled: sidebarFits },
          { id: 'search', label: 'Search', accelerator: 'Ctrl+F', notInFields: true },
        ],
      },
    ],
    (id) => {
      switch (id) {
        case 'new': return newContact();
        case 'new-group': return setNaming({ from: null, name: '', add: [] });
        case 'import': return void importFromFile();
        case 'export': return void exportCards(chosen.length ? chosen.map((e) => e.contact) : items.map((it) => it.contact), sourceTitle);
        case 'edit': return current && act([current], 'edit');
        case 'select-all': return setSelected(items.map((it) => it.key));
        case 'delete': return chosenStored.length > 0 && setDeleting(chosenStored);
        case 'message': case 'email': case 'copy': case 'add':
          return chosen.length > 0 && act(chosen, id);
        case 'sort:given': return setSortBy('given');
        case 'sort:family': return setSortBy('family');
        case 'sidebar': return toggleSidebar(!showSidebar);
        case 'search': return document.getElementById('contacts-search')?.focus();
      }
    },
  );

  const onDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(CONTACT_DRAG)) return;
    e.preventDefault();
    const blobs = [...e.dataTransfer.files];
    void din.drag.accept(e.nativeEvent, 'copy').then(async (result) => {
      if (result?.kind === 'files') return offerImport(result.files);
      const vcards = blobs.filter((f) => /\.(vcf|vcard)$/i.test(f.name));
      if (!vcards.length) return;
      const cards = (await Promise.all(vcards.map((f) => f.text()))).flatMap(parseVCards);
      if (cards.length) setImporting({ name: vcards.length === 1 ? vcards[0].name : `${vcards.length} files`, cards });
    });
  };

  const header = (children: React.ReactNode, className?: string) => (
    <WindowDragRegion className={cn('flex h-13 shrink-0 items-center gap-1', className)}>{children}</WindowDragRegion>
  );

  if (!fsAvailable) {
    return (
      <div className="flex h-full flex-col bg-background text-foreground">
        {header(<><span className="flex-1" /><WindowControls /></>, 'px-3')}
        <div className="grid flex-1 place-items-center p-8">
          <div className="flex max-w-sm flex-col items-center text-center">
            <img src="/icons/apps/contacts.png" alt="" className="mb-4 size-28 drop-shadow-md" />
            <h1 className="font-[family-name:var(--font-title)] text-2xl font-semibold">Contacts</h1>
            <p className="mt-2 text-[15px] text-muted-foreground">Contacts keeps your address book on this computer, so it needs the Din desktop app.</p>
          </div>
        </div>
      </div>
    );
  }

  const paneOpen = !!editor || chosen.length > 0;
  const showList = twoPanes || !paneOpen;
  const showPane = twoPanes || paneOpen;
  const listLoading = source.kind === 'phone' ? phonesLoading.has(source.id) : book.isPending;

  const emptyList =
    search ? (
      <EmptyCard>No one matches “{search}”.</EmptyCard>
    ) : source.kind === 'phone' ? (
      <EmptyCard>
        No contacts from this phone yet. Turn on <span className="font-medium text-foreground">Sync Contacts</span> for this computer in the phone’s Bluetooth settings.
      </EmptyCard>
    ) : source.kind === 'group' ? (
      <EmptyCard>No one’s in {source.name} yet. Drag people here, or pick it under Groups in someone’s menu.</EmptyCard>
    ) : (
      <EmptyCard>
        <BookUser className="mx-auto mb-3 size-8 text-muted-foreground/70" strokeWidth={1.5} />
        Your address book is empty.
        <div className="mt-4 flex flex-col gap-2">
          <DialogButton variant="primary" onClick={newContact} className="inline-flex items-center justify-center gap-1.5">
            <UserPlus className="size-4" /> New Contact
          </DialogButton>
          <DialogButton onClick={() => void importFromFile()} className="inline-flex items-center justify-center gap-1.5">
            <FileUp className="size-4" /> Import vCards…
          </DialogButton>
        </div>
      </EmptyCard>
    );

  return (
    <div className="relative flex h-full text-foreground" onDragOver={(e) => !e.dataTransfer.types.includes(CONTACT_DRAG) && e.preventDefault()} onDrop={onDrop}>
      {showSidebar && (
        <aside aria-label="Groups" className="flex w-56 shrink-0 flex-col border-r border-border/60 bg-background/60">
          {header(
            <>
              <h1 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-[17px] font-bold">Contacts</h1>
              <ToolButton label="Hide sidebar" onClick={() => toggleSidebar(false)}>
                <PanelLeft className="size-4" strokeWidth={1.75} />
              </ToolButton>
            </>,
            'pr-2 pl-4',
          )}
          <Sidebar
            source={source}
            onSource={showSource}
            total={contacts.length}
            groups={groups}
            counts={counts}
            phones={phones}
            phoneCounts={phoneCounts}
            onNewGroup={() => setNaming({ from: null, name: '', add: [] })}
            onRenameGroup={(name) => setNaming({ from: name, name, add: [] })}
            onDeleteGroup={setDeletingGroup}
            onExportGroup={(name) => void exportCards(contacts.filter((c) => c.groups.includes(name)), name)}
            onDropOnGroup={dropOnGroup}
          />
        </aside>
      )}

      {showList && (
        <section aria-label={sourceTitle} className={cn('flex min-w-0 flex-col bg-background', twoPanes ? 'w-72 shrink-0 border-r border-border/60' : 'flex-1')}>
          {header(
            <>
              {!showSidebar && sidebarFits && (
                <ToolButton label="Show sidebar" onClick={() => toggleSidebar(true)}>
                  <PanelLeft className="size-4" strokeWidth={1.75} />
                </ToolButton>
              )}
              {!sidebarFits && <SourcePicker source={source} groups={groups} phones={phones} onSource={showSource} />}
              {sidebarFits && <h2 className="min-w-0 flex-1 truncate pl-1 text-[15px] font-semibold">{sourceTitle}</h2>}
              <span className="text-xs text-muted-foreground tabular-nums" aria-label={`${items.length} contacts`}>{listLoading ? '' : items.length}</span>
              <ToolButton label="New contact" onClick={newContact}>
                <Plus className="size-4.5" />
              </ToolButton>
              {!twoPanes && <WindowControls />}
            </>,
            showSidebar || !sidebarFits ? 'pr-2 pl-3' : 'pr-2 pl-2',
          )}
          <ContactList
            title={sourceTitle}
            items={items}
            sortBy={sortBy}
            selected={new Set(chosen.map((e) => e.key))}
            onSelect={select}
            menuFor={(key) => menuOf(rowTargets(key))}
            onAction={(key, a) => act(rowTargets(key), a)}
            search={search}
            onSearch={setSearch}
            loading={listLoading}
            empty={emptyList}
            dragKeys={source.kind === 'phone' ? undefined : (key) => rowTargets(key).map((e) => e.key)}
          />
        </section>
      )}

      {showPane && (
        <main className="flex min-w-0 flex-1 flex-col bg-background">
          {header(
            <>
              {!twoPanes && (
                <ToolButton label="Back" onClick={() => { setEditor(null); setSelected([]); }}>
                  <ChevronLeft className="size-4.5" />
                </ToolButton>
              )}
              <h2 className="min-w-0 flex-1 truncate pl-1 text-[15px] font-semibold">{editor ? (editor.was ? 'Edit Contact' : 'New Contact') : ''}</h2>
              <WindowControls />
            </>,
            'pr-3 pl-2',
          )}
          {editor ? (
            <ContactEditor
              key={editor.was?.uid ?? editor.draft.uid}
              initial={editor.draft}
              isNew={!editor.was}
              groups={groups}
              saving={saving}
              onSave={(c) => void save(c)}
              onCancel={() => setEditor(null)}
            />
          ) : current ? (
            <ContactCard
              key={current.key}
              contact={current.contact}
              menu={menuOf([current])}
              onAction={(a) => act([current], a)}
              fields={fields}
              readOnly={current.phone ? { from: current.phone.name, inBook: !!current.phone.inBook } : undefined}
            />
          ) : chosen.length > 1 ? (
            <Selection count={chosen.length} onExport={() => act(chosen, 'export')} onDelete={chosenStored.length ? () => setDeleting(chosenStored) : undefined} />
          ) : (
            <div className="grid flex-1 place-items-center p-8 text-center text-[15px] text-muted-foreground">
              {items.length ? 'Choose someone to see their card.' : ''}
            </div>
          )}
        </main>
      )}

      {naming && (
        <Overlay label={naming.from !== null ? 'Rename group' : 'New group'} onClose={() => setNaming(null)} className="max-w-sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveGroup();
            }}
            className="space-y-4 p-5"
          >
            <h2 className="text-base font-semibold">{naming.from !== null ? 'Rename Group' : 'New Group'}</h2>
            {naming.add.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {naming.add.length === 1 ? `${displayName(naming.add[0]) || 'This contact'} goes in it.` : `${naming.add.length} contacts go in it.`}
              </p>
            )}
            <input
              autoFocus
              aria-label="Group name"
              placeholder="Family, Work, Neighbors…"
              value={naming.name}
              onChange={(e) => setNaming({ ...naming, name: e.target.value })}
              className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <div className="flex justify-end gap-2">
              <DialogButton onClick={() => setNaming(null)}>Cancel</DialogButton>
              <DialogButton type="submit" variant="primary" disabled={!naming.name.trim()}>
                {naming.from !== null ? 'Rename' : 'Make Group'}
              </DialogButton>
            </div>
          </form>
        </Overlay>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleting?.length === 1 ? `Delete ${displayName(deleting[0]) || 'this contact'}?` : `Delete ${deleting?.length} contacts?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.length === 1 ? 'Their card is' : 'Their cards are'} removed from this computer’s address book. This can’t be undone; export a vCard first to keep a copy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && void remove(deleting)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deletingGroup !== null} onOpenChange={(o) => !o && setDeletingGroup(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the group “{deletingGroup}”?</AlertDialogTitle>
            <AlertDialogDescription>The people in it aren’t deleted; they stay in All Contacts.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deletingGroup !== null && void deleteGroup(deletingGroup)}>
              Delete Group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={importing !== null} onOpenChange={(o) => !o && setImporting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {importing?.cards.length === 1 ? `Add ${displayName(importing.cards[0]) || 'this contact'} to your contacts?` : `Import ${importing?.cards.length} contacts?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              From {importing?.name}. Anyone already in your contacts gets what the file adds; no one is changed otherwise.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => importing && void runImport(importing.cards)}>Import</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border px-5 py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

function Selection({ count, onExport, onDelete }: { count: number; onExport: () => void; onDelete?: () => void }) {
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="flex flex-col items-center text-center">
        <Users className="size-12 text-muted-foreground/70" strokeWidth={1.25} />
        <p className="mt-3 text-lg font-semibold">{count} contacts selected</p>
        <div className="mt-4 flex gap-2">
          <DialogButton onClick={onExport}>Export vCards…</DialogButton>
          {onDelete && <DialogButton variant="destructive" onClick={onDelete}>Delete…</DialogButton>}
        </div>
      </div>
    </div>
  );
}

/** In a window too narrow for the sidebar: which list to show, from the header. */
function SourcePicker({ source, groups, phones, onSource }: { source: Source; groups: readonly string[]; phones: readonly { id: string; name: string }[]; onSource: (s: Source) => void }) {
  const options: { value: string; label: string; source: Source }[] = [
    { value: 'all', label: 'All Contacts', source: { kind: 'all' } },
    ...groups.map((name) => ({ value: `group:${name}`, label: name, source: { kind: 'group', name } as Source })),
    ...phones.map((p) => ({ value: `phone:${p.id}`, label: p.name, source: { kind: 'phone', id: p.id } as Source })),
  ];
  const value = options.find((o) => sameSource(o.source, source))?.value ?? 'all';
  return (
    <label className="relative flex min-w-0 flex-1 items-center gap-1.5">
      {source.kind === 'phone' ? <Smartphone className="size-4 shrink-0 text-muted-foreground" /> : <BookUser className="size-4 shrink-0 text-muted-foreground" />}
      <span className="sr-only">Show</span>
      <select
        value={value}
        onChange={(e) => {
          const o = options.find((x) => x.value === e.target.value);
          if (o) onSource(o.source);
        }}
        className="h-8 min-w-0 flex-1 truncate rounded-md bg-transparent pr-1 text-[15px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-8 shrink-0 place-items-center rounded-md text-foreground/80 outline-none hover:bg-foreground/[0.08] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {children}
    </button>
  );
}
