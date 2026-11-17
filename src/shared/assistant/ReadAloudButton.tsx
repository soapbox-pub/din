import { Loader2, Square, Volume2 } from 'lucide-react';
import { useAssistantHost } from '@/shared/assistant/host';
import { cn } from '@/lib/utils';

/**
 * Read a reply aloud in Din's voice, beside Copy reply; Stop while it's
 * reading (a spinner until the first words come). Not there while no voice
 * is installed.
 */
export function ReadAloudButton({ text, id, className }: { text: string; id: string; className?: string }) {
  const voice = useAssistantHost().useVoice();
  if (!voice.available) return null;
  const mine = voice.speaking === id;
  const label = mine ? 'Stop reading' : 'Read aloud';
  const Icon = !mine ? Volume2 : voice.started ? Square : Loader2;
  return (
    <button
      type="button"
      onClick={() => (mine ? voice.stop() : voice.speak(text, id))}
      aria-label={label}
      aria-pressed={mine}
      title={label}
      data-speaking={mine || undefined}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        mine && 'text-ink-accent',
        className,
      )}
    >
      <Icon
        className={cn('size-4', mine && !voice.started && 'animate-spin', mine && voice.started && 'size-3.5 fill-current')}
        aria-hidden
      />
    </button>
  );
}
