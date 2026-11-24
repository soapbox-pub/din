import { useId, useState, type FormEvent } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { assistantApi, cleanAssistantError, SECRET_NAME } from '@/lib/assistant';
import { cn } from '@/lib/utils';
import { useAssistantHost } from '@/shared/assistant/host';
import type { SecretRequest } from '@/shared/assistant/secretRequests';

/*
 * Secrets handed to a conversation: values (a token, a password) its shell
 * commands get as environment variables, kept out of the conversation by
 * Din's OpenCode plugin (os/opencode/plugins/din/secrets.ts). The user
 * attaches one with + → Secret… (`SecretDialog`), or gives one the agent
 * asks for with its `ask_secret` tool (`SecretRequestCard`).
 */

/** What's typed as a name, as an environment variable's: `github token` is GITHUB_TOKEN. */
function variableName(typed: string): string {
  return typed
    .toUpperCase()
    .replace(/[\s.-]+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
    .slice(0, 64);
}

/** + → Secret…: a name and a value, attached to the message being written. */
export function SecretDialog({
  open,
  onOpenChange,
  onAdd,
  taken = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (name: string, value: string) => void;
  /** Names already attached. */
  taken?: string[];
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const id = useId();
  const validName = SECRET_NAME.test(name);
  const clash = taken.includes(name);

  const close = (next: boolean) => {
    if (!next) {
      setName('');
      setValue('');
    }
    onOpenChange(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!validName || !value) return;
    onAdd(name, value);
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a secret</DialogTitle>
            <DialogDescription>
              The assistant’s commands get it as an environment variable for the rest of this conversation. It never sees
              the value, which isn’t saved anywhere and is gone when the conversation is deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(variableName(e.target.value))}
              placeholder="GITHUB_TOKEN"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="font-mono"
              aria-invalid={(name !== '' && !validName) || clash || undefined}
              aria-describedby={`${id}-name-hint`}
            />
            <p id={`${id}-name-hint`} className={cn('text-xs text-muted-foreground', (clash || (name && !validName)) && 'text-destructive')}>
              {clash
                ? 'That name is attached already; this one replaces it.'
                : name && !validName
                  ? 'A name can’t start with a digit.'
                  : `The assistant uses it as $${name || 'NAME'}.`}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-value`}>Value</Label>
            <Input
              id={`${id}-value`}
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Paste it here"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!validName || !value}>
              Add Secret
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The agent asking for a secret: a field for it, given to the conversation's commands and never to the agent. */
export function SecretRequestCard({ request, className }: { request: SecretRequest; className?: string }) {
  const { notify } = useAssistantHost();
  const [value, setValue] = useState('');
  const [picked, setPicked] = useState<'give' | 'decline' | null>(null);
  const id = useId();
  const answer = useMutation({
    mutationFn: (given: string | null) => assistantApi.answerSecret(request.sessionID, request.callID, given),
    onSuccess: (ok) => {
      if (ok) return;
      setPicked(null);
      notify({ title: 'The assistant stopped asking', description: 'It no longer waits for this secret.', destructive: true });
    },
    onError: (error) => {
      setPicked(null);
      notify({ title: 'Couldn’t answer', description: cleanAssistantError(error), destructive: true });
    },
  });
  const send = (given: string | null) => {
    setPicked(given === null ? 'decline' : 'give');
    answer.mutate(given);
  };
  const busy = answer.isPending || (answer.isSuccess && answer.data);

  return (
    <section aria-label="Secret request" className={cn('rounded-xl bg-selected p-4', className)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value && !busy) send(value);
        }}
      >
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 size-5 shrink-0 text-ink-accent" aria-hidden />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="font-medium text-foreground">
              The assistant asks for <span className="font-mono">${request.name}</span>
            </p>
            {request.description && <p className="text-sm text-muted-foreground">{request.description}</p>}
            <Label htmlFor={id} className="sr-only">
              {request.name}
            </Label>
            <Input
              id={id}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste it here"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-describedby={`${id}-note`}
            />
            <p id={`${id}-note`} className="text-xs text-muted-foreground">
              Its commands get it as an environment variable; the assistant never sees the value.
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => send(null)}>
            {busy && picked === 'decline' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Decline
          </Button>
          <Button type="submit" size="sm" disabled={!value || !!busy}>
            {busy && picked === 'give' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Give Secret
          </Button>
        </div>
      </form>
    </section>
  );
}
