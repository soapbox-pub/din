import { useState, useSyncExternalStore } from 'react';
import { currentAsk, finishAsk, subscribeAsk, type Ask } from './askText';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/** Renders the open question, if any. One per Media Player window. */
export function TextPromptHost() {
  const ask = useSyncExternalStore(subscribeAsk, currentAsk);
  return <Prompt key={ask ? `${ask.title}:${ask.initial}` : 'none'} ask={ask} />;
}

function Prompt({ ask }: { ask: Ask | null }) {
  const [value, setValue] = useState(ask?.initial ?? '');
  return (
    <Dialog open={ask !== null} onOpenChange={(open) => !open && finishAsk(null)}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) finishAsk(value.trim());
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>{ask?.title}</DialogTitle>
            <DialogDescription>{ask?.label}</DialogDescription>
          </DialogHeader>
          <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-label={ask?.label} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finishAsk(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              {ask?.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
