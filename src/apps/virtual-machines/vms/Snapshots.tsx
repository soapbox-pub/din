import { useState, type FormEvent } from 'react';
import { Camera, History, Loader2, MoreHorizontal, Trash2 } from 'lucide-react';
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
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { VmInfo, VmSnapshot } from '@/lib/vms';
import { formatBytes, isOn, useBridge, useSnapshots } from './bridge';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function defaultName(): string {
  return `Snapshot ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()).replace(/["\\]/g, '')}`;
}

/** Name a new snapshot, and take it. */
export function TakeSnapshotDialog({ vm, onOpenChange, onError }: { vm: VmInfo; onOpenChange: (open: boolean) => void; onError: (err: unknown) => void }) {
  const bridge = useBridge()!;
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await bridge.takeSnapshot(vm.id, name.trim());
      onOpenChange(false);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Take a Snapshot</DialogTitle>
            <DialogDescription>
              {isOn(vm)
                ? 'Its disk and what it’s doing now, open windows and all. It pauses for a moment while this is saved.'
                : 'Its disk as it is now, to go back to.'}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Snapshot name"
            value={name}
            onChange={(e) => setName(e.target.value.replace(/["\\]/g, ''))}
            maxLength={64}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Take Snapshot
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Confirming = { action: 'restore' | 'delete'; snapshot: VmSnapshot } | null;

/** A machine's snapshots, oldest first, to go back to or delete. */
export function SnapshotList({ vm, onTake, onError }: { vm: VmInfo; onTake: () => void; onError: (err: unknown) => void }) {
  const bridge = useBridge()!;
  const { data: snapshots, isLoading } = useSnapshots(vm.id);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyState = vm.state === 'starting' || vm.state === 'stopping';

  const act = async (action: 'restore' | 'delete', snapshot: VmSnapshot) => {
    setBusy(snapshot.name);
    try {
      if (action === 'restore') await bridge.restoreSnapshot(vm.id, snapshot.name);
      else await bridge.deleteSnapshot(vm.id, snapshot.name);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  const items = (s: VmSnapshot, Item: typeof DropdownMenuItem | typeof ContextMenuItem, Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator) => (
    <>
      <Item onSelect={() => setConfirming({ action: 'restore', snapshot: s })} disabled={busyState}>
        <History className="size-4" aria-hidden />
        Restore…
      </Item>
      <Separator />
      <Item variant="destructive" onSelect={() => setConfirming({ action: 'delete', snapshot: s })} disabled={busyState}>
        <Trash2 className="size-4" aria-hidden />
        Delete…
      </Item>
    </>
  );

  const restoreText = (s: VmSnapshot) =>
    s.stateBytes > 0
      ? `It goes back to just as it was then, running. What’s happened in it since is lost, unless you take a snapshot first.`
      : `It’s turned off and its disk goes back to how it was then. What’s happened in it since is lost, unless you take a snapshot first.`;

  return (
    <section aria-label="Snapshots" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Snapshots</h2>
        <Button variant="outline" size="sm" onClick={onTake} disabled={busyState}>
          <Camera className="size-4" aria-hidden />
          Take Snapshot…
        </Button>
      </div>
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : !snapshots?.length ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Take a snapshot before trying something risky, and come back to it if it goes wrong.
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border/70">
          {snapshots.map((s) => (
            <ContextMenu key={s.name}>
              <ContextMenuTrigger asChild>
                <li className="flex items-center gap-3 px-3 py-2.5">
                  <Camera className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{s.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {dateFormat.format(new Date(s.date))}
                      {s.stateBytes > 0 ? ` · Running · ${formatBytes(s.stateBytes)} of memory` : ' · Off'}
                    </p>
                  </div>
                  {busy === s.name ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Working" />
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${s.name}`}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        {items(s, DropdownMenuItem, DropdownMenuSeparator)}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-44">{items(s, ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
            </ContextMenu>
          ))}
        </ul>
      )}

      <AlertDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.action === 'restore' ? `Restore “${confirming.snapshot.name}”?` : `Delete “${confirming?.snapshot.name}”?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.action === 'restore' ? restoreText(confirming.snapshot) : 'The machine stays as it is now; you just can’t go back to this snapshot.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={confirming?.action === 'delete' ? 'bg-destructive text-white hover:bg-destructive/90' : undefined}
              onClick={() => confirming && void act(confirming.action, confirming.snapshot)}
            >
              {confirming?.action === 'restore' ? 'Restore' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
