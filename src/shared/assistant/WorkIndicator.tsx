import { Loader2, SquareTerminal } from 'lucide-react';
import type { WorkKind } from '@/hooks/useAssistant';
import { cn } from '@/lib/utils';

/** What a conversation's commands left running in the background say about them. */
function commandsLabel(count: number): string {
  return count === 1 ? '1 command running in the background' : `${count} commands running in the background`;
}

/**
 * Whether a conversation is busy, and with what (`workKind`): a spinner while
 * an agent is at work in it, its own turn or a subagent's; a still terminal
 * once all that's left is commands it started running in the background (a
 * dev server, a long build), which aren't the agent thinking.
 */
export function WorkIndicator({
  kind,
  commands = 0,
  className,
}: {
  kind: Exclude<WorkKind, null>;
  /** How many commands are running, for the label. */
  commands?: number;
  className?: string;
}) {
  if (kind === 'agent') return <Loader2 className={cn('size-3.5 shrink-0 animate-spin', className)} aria-label="Working" />;
  const label = commands > 0 ? commandsLabel(commands) : 'Running in the background';
  return (
    <SquareTerminal className={cn('size-3.5 shrink-0', className)} role="img" aria-label={label}>
      <title>{label}</title>
    </SquareTerminal>
  );
}
