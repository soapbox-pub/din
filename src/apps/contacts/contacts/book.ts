import { useCallback, useEffect } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { cleanFsError } from '@/lib/fs';
import type { PhoneContact, PhoneDevice } from '@/lib/phone';
import { useDin } from '@/sdk/react';
import { contactsFolder, loadAddressBook, type AddressBook, type ContactsFs } from '@/shared/contacts';
import { toast } from '@/shared/toast';

const BOOK = ['contacts', 'book'] as const;

/** Contacts' own folder, by path (its manifest's `din.folders`). */
export function useContactsFs(): ContactsFs | null {
  return useDin().system.fs ?? null;
}

/** The address book, read again whenever something changes its folder (`din contacts`, a sync tool, another window). */
export function useAddressBook() {
  const fs = useDin().system.fs ?? null;
  const qc = useQueryClient();
  useEffect(() => {
    if (!fs) return;
    let watch: number | null = null;
    let gone = false;
    let folder = '';
    const off = fs.onChange((path) => {
      if (folder && (path === folder || path.startsWith(`${folder}/`))) void qc.invalidateQueries({ queryKey: BOOK });
    });
    void (async () => {
      folder = await contactsFolder(fs);
      await fs.mkdir(folder).catch(() => {});
      const id = await fs.watch(folder).catch(() => null);
      if (gone && id !== null) void fs.unwatch(id);
      else watch = id;
    })();
    return () => {
      gone = true;
      off();
      if (watch !== null) void fs.unwatch(watch);
    };
  }, [fs, qc]);
  return useQuery<AddressBook>({
    queryKey: BOOK,
    queryFn: () => loadAddressBook(fs!),
    enabled: !!fs,
    staleTime: Infinity,
  });
}

/** Run a change to the address book: a failure is a toast, and the book is read again either way. */
export function useBookChange() {
  const fs = useContactsFs();
  const qc = useQueryClient();
  return useCallback(
    async <T,>(change: (fs: ContactsFs) => Promise<T>, failure: string): Promise<T | undefined> => {
      if (!fs) return undefined;
      try {
        return await change(fs);
      } catch (error) {
        toast(failure, { body: cleanFsError(error), destructive: true });
        return undefined;
      } finally {
        await qc.invalidateQueries({ queryKey: BOOK });
      }
    },
    [fs, qc],
  );
}

/** The user's phones and the contacts each has sent (Settings → Phone's Sync Contacts). */
export function usePhones(): { phones: PhoneDevice[]; contacts: Map<string, PhoneContact[]>; loading: Set<string>; ready: boolean } {
  const phone = useDin().system.phone ?? null;
  const qc = useQueryClient();
  useEffect(() => phone?.onChanged((state) => qc.setQueryData(['phone', 'state'], state)), [phone, qc]);
  const state = useQuery({
    queryKey: ['phone', 'state'],
    queryFn: () => phone!.state(),
    enabled: !!phone,
    staleTime: Infinity,
  });
  const phones = state.data?.phones ?? [];
  const lists = useQueries({
    queries: phones.map((p) => ({
      queryKey: ['phone', 'contacts', p.id],
      queryFn: () => phone!.contacts(p.id),
      enabled: !!phone,
      staleTime: 60_000,
    })),
  });
  const contacts = new Map<string, PhoneContact[]>();
  const loading = new Set<string>();
  phones.forEach((p, i) => {
    const list = lists[i];
    if (list?.data) contacts.set(p.id, list.data);
    else if (list?.isPending) loading.add(p.id);
  });
  return { phones, contacts, loading, ready: state.isSuccess };
}
