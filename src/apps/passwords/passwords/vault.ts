/**
 * The Passwords app's view of the vault (din.system.passwords): queries over
 * its state, list and items, refetched whenever main says it changed, and
 * what the app derives from them (sections, site names, icon colors).
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { appLink } from '@/shared/launch';
import {
  getPasswordsBridge,
  type PasswordGroup,
  type PasswordsImportResult,
  type PasswordItemInput,
  type PasswordList,
  type PasswordSummary,
  type PasswordsBridge,
} from '@/lib/passwords';

const KEY = ['passwords'] as const;

/** The windows Passwords opens beside its own, by their `window` launch param. */
export type PasswordsWindow = 'settings' | 'import';

/** Open Passwords' settings or import in a window of its own. */
export function openPasswordsWindow(kind: PasswordsWindow): void {
  const size = kind === 'settings' ? { width: 480, height: 600 } : { width: 480, height: 560 };
  void window.open(appLink(null, { window: kind, floating: true, ...size }));
}

/** The channel Passwords' windows talk over: an import done in its window, for the vault's to show. */
const CHANNEL = 'passwords';

export function announceImported(result: PasswordsImportResult): void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ type: 'imported', result });
  channel.close();
}

/** Hear imports done in Passwords' import window. */
export function useImported(onImported: (result: PasswordsImportResult) => void): void {
  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e: MessageEvent<{ type?: string; result?: PasswordsImportResult }>) => {
      if (e.data?.type === 'imported' && e.data.result) onImported(e.data.result);
    };
    return () => channel.close();
  }, [onImported]);
}

export function useBridge(): PasswordsBridge | undefined {
  return getPasswordsBridge();
}

/** Refetch everything when the vault changes (here, in the browser, or in another app). */
export function useVaultEvents(): void {
  const queryClient = useQueryClient();
  const bridge = useBridge();
  useEffect(
    () => bridge?.onChanged(() => void queryClient.invalidateQueries({ queryKey: KEY })),
    [bridge, queryClient],
  );
}

export function useVaultState() {
  const bridge = useBridge();
  return useQuery({
    queryKey: [...KEY, 'state'],
    queryFn: () => bridge!.state(),
    enabled: !!bridge,
    staleTime: Infinity,
  });
}

export function useVaultList(enabled: boolean) {
  const bridge = useBridge();
  return useQuery({
    queryKey: [...KEY, 'list'],
    queryFn: () => bridge!.list(),
    enabled: !!bridge && enabled,
    staleTime: Infinity,
  });
}

export function useVaultItem(id: string | null) {
  const bridge = useBridge();
  return useQuery({
    queryKey: [...KEY, 'item', id],
    queryFn: () => bridge!.get(id!),
    enabled: !!bridge && !!id,
    staleTime: Infinity,
    retry: false,
  });
}

/** What the sidebar can show: the fixed sections, a folder, or Recently Deleted. */
export type Section =
  | { type: 'all' }
  | { type: 'favorites' }
  | { type: 'codes' }
  | { type: 'notes' }
  | { type: 'folder'; id: string }
  | { type: 'trash' };

export function sameSection(a: Section, b: Section): boolean {
  return a.type === b.type && (a.type !== 'folder' || (b.type === 'folder' && a.id === b.id));
}

/** The folder and the folders inside it. */
function folderAndDescendants(groups: PasswordGroup[], id: string): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) {
      if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
        ids.add(g.id);
        grew = true;
      }
    }
  }
  return ids;
}

export function itemsIn(list: PasswordList, section: Section): PasswordSummary[] {
  const live = list.items.filter((i) => !i.trashed);
  switch (section.type) {
    case 'all':
      return live;
    case 'favorites':
      return live.filter((i) => i.favorite);
    case 'codes':
      return live.filter((i) => i.otp);
    case 'notes':
      return live.filter((i) => i.kind === 'note');
    case 'folder': {
      const ids = folderAndDescendants(list.groups, section.id);
      return live.filter((i) => ids.has(i.groupId));
    }
    case 'trash':
      return list.items.filter((i) => i.trashed);
  }
}

export function sectionTitle(section: Section, list: PasswordList | undefined): string {
  switch (section.type) {
    case 'all':
      return 'All Items';
    case 'favorites':
      return 'Favorites';
    case 'codes':
      return 'Codes';
    case 'notes':
      return 'Secure Notes';
    case 'trash':
      return 'Recently Deleted';
    case 'folder':
      return list?.groups.find((g) => g.id === section.id)?.name || 'Folder';
  }
}

/** A site's host from a saved URL ("https://www.github.com/login" → "github.com"). */
export function siteHost(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A URL to open, for a saved one that may lack its scheme. */
export function openableUrl(url: string): string | null {
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const parsed = new URL(full);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** What a row shows as the item's name. */
export function displayTitle(item: Pick<PasswordSummary, 'title' | 'url'>): string {
  return item.title.trim() || siteHost(item.url) || 'Untitled';
}

export function matchesSearch(item: PasswordSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.title, item.username, item.url].some((v) => v.toLowerCase().includes(q));
}

export function byTitle(a: PasswordSummary, b: PasswordSummary): number {
  return displayTitle(a).localeCompare(displayTitle(b), undefined, { sensitivity: 'base' });
}

/** A new item, before it's saved. */
export type BlankItem = PasswordItemInput & { kind: 'login' | 'note' };

export function blankItem(kind: 'login' | 'note', groupId: string): BlankItem {
  return { kind, groupId, title: '', username: '', password: '', url: '', notes: '', otpUri: '', fields: [], favorite: false };
}
