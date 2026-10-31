import { useState, type FormEvent } from 'react';
import { LoaderCircle, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cleanVolumesError, getVolumesBridge } from '@/lib/volumes';

export interface LockedVolume {
  id: string;
  name: string;
}

/**
 * Asks for an encrypted disk's passphrase, unlocks it and mounts what's in
 * it, then hands over where. The desktop shows it from the disk's
 * notification, Files from its sidebar.
 */
export function UnlockVolumeDialog({
  volume,
  onUnlocked,
  onClose,
}: {
  /** The disk to unlock; null keeps the dialog closed. */
  volume: LockedVolume | null;
  onUnlocked: (mountPoint: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={volume !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        {volume && <UnlockForm key={volume.id} volume={volume} onUnlocked={onUnlocked} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function UnlockForm({
  volume,
  onUnlocked,
  onClose,
}: {
  volume: LockedVolume;
  onUnlocked: (mountPoint: string) => void;
  onClose: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const bridge = getVolumesBridge();
    if (!bridge || busy || !passphrase) return;
    setBusy(true);
    setError(null);
    bridge.unlock(volume.id, passphrase).then(
      (mountPoint) => {
        setBusy(false);
        onUnlocked(mountPoint);
      },
      (err: unknown) => {
        setBusy(false);
        setError(cleanVolumesError(err));
      },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Lock className="size-4 text-muted-foreground" aria-hidden />
          Unlock “{volume.name}”
        </DialogTitle>
        <DialogDescription>This disk is encrypted. Enter its passphrase to open it.</DialogDescription>
      </DialogHeader>
      <Input
        type="password"
        autoComplete="off"
        autoFocus
        aria-label="Passphrase"
        placeholder="Passphrase"
        value={passphrase}
        disabled={busy}
        aria-invalid={error !== null}
        onChange={(e) => {
          setPassphrase(e.target.value);
          setError(null);
        }}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !passphrase}>
          {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          Unlock
        </Button>
      </DialogFooter>
    </form>
  );
}
