import { LayoutGrid } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { LoginArea } from '@/components/auth/LoginArea';
import { useClock } from '@/hooks/useClock';

/** Bottom toolbar: app launcher, running apps (future), clock, account menu. */
export function Taskbar() {
  const now = useClock();

  return (
    <footer className="relative z-10 flex h-14 items-center gap-2 border-t border-white/10 bg-black/50 px-2 backdrop-blur-xl">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open app launcher"
            className="size-10 rounded-lg text-white/90 hover:bg-white/10 hover:text-white"
          >
            <LayoutGrid className="size-5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={12}
          className="w-72"
        >
          <div className="rounded-lg border border-dashed border-border py-8 px-4 text-center">
            <p className="text-sm text-muted-foreground">
              No apps installed yet. The launcher will live here.
            </p>
          </div>
        </PopoverContent>
      </Popover>

      {/* Running apps will go here */}
      <div className="flex-1" />

      <time
        dateTime={now.toISOString()}
        className="px-2 text-right text-sm leading-tight text-white/90 tabular-nums"
      >
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        <span className="block text-xs text-white/50">
          {now.toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </span>
      </time>

      <LoginArea />
    </footer>
  );
}
