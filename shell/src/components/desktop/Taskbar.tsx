import { LayoutGrid } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { LoginArea } from '@/components/auth/LoginArea';
import { useClock } from '@/hooks/useClock';
import { cn } from '@/lib/utils';
import { APPS, getApp } from '@/lib/apps';
import { useWindowManager } from '@/contexts/WindowManagerContext';

/** Bottom toolbar: app launcher, running apps, clock, account menu. */
export function Taskbar() {
  const now = useClock();
  const { windows, open, focus } = useWindowManager();

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
          <div className="grid grid-cols-3 gap-2">
            {APPS.map((app) => (
              <PopoverClose asChild key={app.id}>
                <button
                  type="button"
                  onClick={() => open(app.id)}
                  className="flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <app.icon className="size-7 text-foreground" aria-hidden />
                  <span className="text-xs leading-tight text-foreground">
                    {app.name}
                  </span>
                </button>
              </PopoverClose>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Running apps */}
      <div className="flex flex-1 items-center gap-1">
        {windows.map((win) => {
          const app = getApp(win.appId);
          if (!app) return null;
          return (
            <Button
              key={win.id}
              variant="ghost"
              size="icon"
              aria-label={`Focus ${app.name}`}
              onClick={() => focus(win.id)}
              className={cn(
                'size-10 rounded-lg text-white/90 hover:bg-white/10 hover:text-white',
                !win.minimized && 'bg-white/10',
              )}
            >
              <app.icon className="size-5" />
            </Button>
          );
        })}
      </div>

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
