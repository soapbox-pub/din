import { Cloud, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTurnOnDrive } from '@/hooks/useDrive';
import { cleanDriveError, type DriveStatus } from '@/lib/drive';
import { cn } from '@/lib/utils';

/**
 * What Drive shows before it's on, in Files (at ~/Drive) and Settings → Drive:
 * what it is in a line, and one button. Turning it on finds the account's
 * drive, or creates one, and mounts it; how it's stored is Settings' business
 * afterwards, not something to decide here.
 */
export function DriveWelcome({ onReady, className }: { onReady?: (status: DriveStatus) => void; className?: string }) {
  const turnOn = useTurnOnDrive();
  const pending = turnOn.isPending;

  return (
    <div className={cn('flex flex-1 flex-col items-center justify-center gap-6 px-8 py-12 text-center', className)}>
      <div className="flex size-20 items-center justify-center rounded-full bg-pigment text-primary-foreground clay-pigment">
        <Cloud className="size-10" strokeWidth={1.5} aria-hidden />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="font-[family-name:var(--font-title)] text-2xl font-semibold text-foreground">Drive</h2>
        <p className="text-base text-muted-foreground">Your files, on all your devices.</p>
      </div>
      <Button
        size="lg"
        className="rounded-full bg-pigment px-6 clay-pigment"
        disabled={pending}
        onClick={() => turnOn.mutate(undefined, { onSuccess: (status) => onReady?.(status) })}
      >
        {pending && <Loader2 className="size-4.5 animate-spin" aria-hidden />}
        {pending ? 'Turning On…' : 'Turn On Drive'}
      </Button>
      {turnOn.isError ? (
        <p role="alert" className="max-w-sm text-sm text-destructive">
          {cleanDriveError(turnOn.error)}
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Lock className="size-4.5" aria-hidden />
          Private. Only you can open your files.
        </p>
      )}
    </div>
  );
}
