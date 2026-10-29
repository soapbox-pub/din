import { GitFork, MessageSquare } from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { relativeTime, type SessionMessage } from '@/lib/assistant';

export type UserMessage = Extract<SessionMessage, { type: 'user' }>;

/**
 * /fork's picker, as in OpenCode: the whole conversation, or from one of the
 * user's messages, newest first. Forking from a message leaves it out of the
 * new conversation and puts it in the composer instead, to send again or
 * change first.
 */
export function ForkDialog({
  messages,
  open,
  onOpenChange,
  onFork,
}: {
  messages: SessionMessage[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fork from before `message`, or the whole conversation without one. */
  onFork: (message?: UserMessage) => void;
}) {
  const prompts = messages.filter((m): m is UserMessage => m.type === 'user' && !!m.text.trim()).reverse();
  const pick = (message?: UserMessage) => {
    onOpenChange(false);
    onFork(message);
  };
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Fork conversation"
      description="Start a new conversation with this one’s history, all of it or up to one of your messages."
    >
      <CommandInput placeholder="Fork from a message…" />
      <CommandList>
        <CommandEmpty>No messages match.</CommandEmpty>
        <CommandGroup>
          <CommandItem value="whole conversation" onSelect={() => pick()}>
            <GitFork aria-hidden /> Whole conversation
          </CommandItem>
        </CommandGroup>
        {prompts.length > 0 && (
          <CommandGroup heading="From before a message">
            {prompts.map((message) => (
              <CommandItem key={message.id} value={`${message.id} ${message.text}`} onSelect={() => pick(message)}>
                <MessageSquare aria-hidden />
                <span className="min-w-0 flex-1 truncate">{message.text.replace(/\s+/g, ' ')}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(message.time.created)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
