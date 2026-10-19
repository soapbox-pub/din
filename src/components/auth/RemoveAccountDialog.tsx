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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { useNostrd } from '@/hooks/useNostrd';
import { NostrdCode, NostrdError } from '@/lib/nostrd';

interface RemoveAccountDialogProps {
  /** The account to remove, or null when closed. */
  account: { pubkey: string; name: string } | null;
  onClose: () => void;
}

/**
 * Delete an account's secret key from nostrd, the computer's signer. Unlike
 * signing out this can't be undone without a backup, so it takes the
 * computer's password.
 */
export function RemoveAccountDialog({ account, onClose }: RemoveAccountDialogProps) {
  const { removeNostrdAccount } = useLoggedInAccounts();
  const { status } = useNostrd();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const needsPassword = status?.has_password ?? true;

  const close = () => {
    setPassword('');
    setError('');
    onClose();
  };

  const remove = async () => {
    if (!account) return;
    setRemoving(true);
    setError('');
    try {
      await removeNostrdAccount(account.pubkey, password);
      close();
    } catch (e) {
      setError(
        e instanceof NostrdError && e.code === NostrdCode.WrongPassword
          ? 'That password is not right.'
          : e instanceof Error ? e.message : String(e),
      );
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Dialog open={account !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {account?.name} from this computer?</DialogTitle>
          <DialogDescription>
            This deletes the account's secret key from this computer. Unless you
            have a backup of it, the account can't be used again.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void remove();
          }}
        >
          {needsPassword && (
            <div className="space-y-2">
              <Label htmlFor="remove-account-password">Computer password</Label>
              <Input
                id="remove-account-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError('');
                }}
              />
            </div>
          )}
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={removing || (needsPassword && !password)}
            >
              {removing && <Loader2 className="animate-spin" aria-hidden />}
              Remove
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
