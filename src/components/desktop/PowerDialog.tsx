import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cleanPowerError, getPowerBridge } from '@/lib/power';

export type PowerAction = 'reboot' | 'powerOff';

const COPY: Record<PowerAction, { title: string; description: string; confirm: string }> = {
  reboot: {
    title: 'Restart the computer?',
    description: 'Open apps will close, and anything unsaved in them will be lost.',
    confirm: 'Restart',
  },
  powerOff: {
    title: 'Shut down the computer?',
    description: 'Open apps will close, and anything unsaved in them will be lost.',
    confirm: 'Shut down',
  },
};

interface PowerDialogProps {
  /** The action to confirm, or null when closed. */
  action: PowerAction | null;
  onClose: () => void;
}

/** Confirm a restart or shutdown, since either closes every open app. */
export function PowerDialog({ action, onClose }: PowerDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // Keep the last action's text while the dialog animates closed.
  const [shown, setShown] = useState<PowerAction>('powerOff');
  if (action && action !== shown) setShown(action);
  const copy = COPY[shown];

  const close = () => {
    setError('');
    onClose();
  };

  const confirm = async () => {
    const bridge = getPowerBridge();
    if (!bridge || !action) return;
    setPending(true);
    setError('');
    try {
      await (action === 'reboot' ? bridge.reboot() : bridge.powerOff());
      // The computer is going down; leave the dialog up until it does.
    } catch (e) {
      setError(cleanPowerError(e));
      setPending(false);
    }
  };

  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && !pending && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button type="button" autoFocus disabled={pending} onClick={() => void confirm()}>
            {pending && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
