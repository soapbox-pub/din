import { Loader2, Mic, MicOff, X } from 'lucide-react';
import { useDictation } from '@/hooks/useDictation';
import { cancelDictation } from '@/lib/dictation';
import { cn } from '@/lib/utils';
import { glassPanel } from '@/shared/appChromeStyles';

/**
 * The bar that shows dictation listening: the microphone's level, what's
 * been heard so far, and how to finish. Never takes focus, so the text goes
 * where the keyboard was.
 */
export function DictationOverlay() {
  const { status, level, preview, error, held } = useDictation();
  const visible = status !== 'idle';

  const hint =
    status === 'transcribing'
      ? 'Typing…'
      : held
        ? 'Let go to finish'
        : 'Pause or press Super+H to finish · Esc to cancel';

  return (
    <div
      className={cn(
        'pointer-events-none fixed inset-x-0 bottom-36 z-[9998] flex justify-center px-4',
        'transition-opacity duration-200 motion-reduce:transition-none',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      {visible && (
        <div
          role="status"
          aria-live="polite"
          className={cn('pointer-events-auto flex w-[min(36rem,100%)] items-center gap-3 py-3 pl-3 pr-2', glassPanel)}
        >
          <span className="relative grid size-10 shrink-0 place-items-center">
            {status === 'listening' && (
              <span
                aria-hidden
                className="absolute inset-0 rounded-full bg-primary/25 transition-transform duration-75 motion-reduce:hidden"
                style={{ transform: `scale(${0.7 + level * 0.6})` }}
              />
            )}
            <span
              className={cn(
                'relative grid size-8 place-items-center rounded-full',
                status === 'error' ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground',
              )}
            >
              {status === 'error' ? (
                <MicOff className="size-4" aria-hidden />
              ) : status === 'transcribing' ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <Mic className="size-4" aria-hidden />
              )}
            </span>
          </span>
          <div className="min-w-0 flex-1">
            {status === 'error' ? (
              <p className="text-sm font-medium text-foreground">{error}</p>
            ) : (
              <>
                <p
                  className={cn(
                    'line-clamp-2 text-sm',
                    preview ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {preview || 'Listening…'}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
              </>
            )}
          </div>
          {status !== 'error' && (
            <button
              type="button"
              // Keeps focus where the text is going.
              onMouseDown={(event) => event.preventDefault()}
              onClick={cancelDictation}
              aria-label="Cancel dictation"
              title="Cancel"
              className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
