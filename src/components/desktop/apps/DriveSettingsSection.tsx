import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Cloud, CloudOff, FileText, Folder, FolderOpen, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import {
  ActionButton,
  ActionButtons,
  DetailsError,
  DetailsHero,
  InfoList,
  InfoRow,
} from '@/components/desktop/apps/DetailsPage';
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
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useToast } from '@/hooks/useToast';
import { useDriveState } from '@/hooks/useDrive';
import { cleanDriveError, describeDrive, getDriveBridge, type DriveTrashItem } from '@/lib/drive';
import { DriveWelcome } from '@/shared/DriveWelcome';
import { formatBytes } from '@/lib/fs';
import { cn } from '@/lib/utils';
import { settingsCard, settingsEmpty, settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsFallback, SettingsSection, SettingsSubHeading } from '@/shared/settingsSection';

/** How often the drive's state is asked for while the section is open. */
const POLL_MS = 3_000;

/**
 * Settings → Drive: Din Drive, the encrypted drive on Nostr and Blossom that
 * din-drive mounts at ~/Drive (electron/drive.mts). Until it's on, the same
 * welcome as Files' (DriveWelcome); once it's mounted this shows whether it's
 * in sync, where it keeps things, and its trash, where things deleted from it
 * wait 30 days before they're gone for good.
 */
export function DriveSettingsSection() {
  const bridge = getDriveBridge();
  const { open } = useWindowActions();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [emptying, setEmptying] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const state = useDriveState(POLL_MS).data ?? null;
  const trashQuery = useQuery({
    queryKey: ['drive', 'trash'],
    queryFn: () => bridge!.trash(),
    enabled: !!bridge && !!state?.status,
    refetchInterval: POLL_MS,
  });
  const trash = state?.status ? (trashQuery.data ?? []) : [];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['drive'] });

  const failed = (title: string) => (error: unknown) =>
    toast({ title, description: cleanDriveError(error), variant: 'destructive' });

  const restore = (item: DriveTrashItem) => {
    bridge
      ?.restore(item.id)
      .then(() => refresh())
      .catch(failed(`Couldn’t restore “${item.name}”`));
  };

  const emptyTrash = () => {
    if (!bridge) return;
    setEmptying(true);
    bridge
      .emptyTrash()
      .then(() => refresh())
      .catch(failed('Couldn’t empty the trash'))
      .finally(() => setEmptying(false));
  };

  const status = state?.status;

  return (
    <SettingsSection title="Drive">
      {!bridge ? (
        <SettingsFallback icon={Cloud}>Drive needs the Din desktop shell; it isn’t available in a plain browser.</SettingsFallback>
      ) : !state ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : !state.available ? (
        <SettingsFallback icon={CloudOff}>Din Drive isn’t on this computer.</SettingsFallback>
      ) : !status ? (
        <DriveWelcome />
      ) : (
        <>
          <DetailsHero
            icon={status.last_error ? <AlertTriangle aria-hidden /> : <Cloud aria-hidden />}
            name="Drive"
            status={describeDrive(status)}
            active={!status.last_error && status.connected_relays > 0}
          />
          {status.last_error && <DetailsError>{status.last_error}</DetailsError>}
          <ActionButtons>
            <ActionButton icon={FolderOpen} label="Open in Files" onClick={() => open('file-browser', { path: status.mountpoint })} />
          </ActionButtons>
          <InfoList>
            <InfoRow label="Location" value={status.mountpoint} />
            <InfoRow label="Items" value={status.items.toLocaleString()} />
            <InfoRow label="Last synced" value={status.last_sync ? new Date(status.last_sync * 1000).toLocaleString() : 'Not yet'} />
            <InfoRow label="Relays" value={`${status.connected_relays} of ${status.relays.length} connected`} />
            <InfoRow label="Blossom servers" value={status.servers.join(', ')} />
          </InfoList>

          <div>
            <div className="flex items-center justify-between gap-2">
              <SettingsSubHeading>Trash</SettingsSubHeading>
              {trash.length > 0 && (
                <Button variant="outline" size="sm" onClick={() => setConfirmEmpty(true)} disabled={emptying}>
                  {emptying ? <Loader2 className="size-4.5 animate-spin" aria-hidden /> : <Trash2 className="size-4.5" aria-hidden />}
                  Empty Trash
                </Button>
              )}
            </div>
            {trash.length === 0 ? (
              <div className={cn(settingsCard, 'mt-2')}>
                <p className={settingsEmpty}>The trash is empty. Things you delete from Drive wait here for 30 days.</p>
              </div>
            ) : (
              <ul className={cn(settingsGroup, 'mt-2')} aria-label="Trash">
                {trash.map((item) => (
                  <TrashRow key={item.id} item={item} onRestore={() => restore(item)} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <AlertDialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Empty the Drive’s trash?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything in it is deleted for good, from every device and from your Blossom servers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20"
              onClick={emptyTrash}
            >
              Empty Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function TrashRow({ item, onRestore }: { item: DriveTrashItem; onRestore: () => void }) {
  const Icon = item.dir ? Folder : FileText;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="flex min-h-12 items-center gap-3 px-4 py-2">
          <Icon className="size-4.5 shrink-0 text-ink-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground">{item.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {item.dir ? 'Folder' : formatBytes(item.size)} · Deleted {new Date(item.trashed * 1000).toLocaleDateString()}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onRestore}>
            <RotateCcw className="size-4.5" aria-hidden />
            Restore
          </Button>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onRestore}>
          <RotateCcw aria-hidden />
          Restore
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
