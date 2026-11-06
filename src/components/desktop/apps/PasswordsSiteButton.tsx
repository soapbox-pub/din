import { useEffect, useState } from 'react';
import { Check, Copy, RectangleEllipsis, User } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { cn } from '@/lib/utils';
import { toolButtonClass } from '@/shared/appChromeStyles';
import { getPasswordsDesktopBridge, type CopyField, type PasswordSummary } from '@/lib/passwords';

function useSiteLogins(url: string) {
  const bridge = getPasswordsDesktopBridge();
  const queryClient = useQueryClient();
  const web = /^https?:\/\//i.test(url);
  useEffect(
    () => bridge?.onChanged(() => void queryClient.invalidateQueries({ queryKey: ['passwords-site'] })),
    [bridge, queryClient],
  );
  return useQuery({
    queryKey: ['passwords-site', url],
    queryFn: () => bridge!.siteLogins(url),
    enabled: !!bridge && web,
    staleTime: Infinity,
  });
}

function CopyButton({ label, icon, onCopy }: { label: string; icon: React.ReactNode; onCopy: () => Promise<void> }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label={done ? 'Copied' : label}
      title={label}
      onClick={() => void onCopy().then(() => setDone(true))}
    >
      {done ? <Check className="size-3.5 text-ink-accent" /> : icon}
    </Button>
  );
}

/**
 * Shown in the browser's toolbar for a site Passwords has logins for: them,
 * to fill into the page or copy, and the way to Passwords. Renders nothing
 * for other sites, or while Passwords is locked.
 */
export function PasswordsSiteButton({ url, wcId }: { url: string; wcId: number | null }) {
  const bridge = getPasswordsDesktopBridge();
  const { open: openApp } = useWindowActions();
  const { data: logins } = useSiteLogins(url);
  const [open, setOpen] = useState(false);
  if (!bridge || !logins || logins.length === 0) return null;

  const label = logins.length === 1 ? 'A saved password for this site' : `${logins.length} saved passwords for this site`;
  const copy = (login: PasswordSummary, field: CopyField) => () => bridge.copy(login.id, field);
  const fill = (login: PasswordSummary) => {
    setOpen(false);
    if (wcId !== null) void bridge.fillPage(wcId, login.id);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={cn(
            toolButtonClass,
            open && 'bg-foreground/10 text-foreground',
          )}
        >
          <RectangleEllipsis className="size-4.5" strokeWidth={1.75} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 space-y-2 p-2">
        <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">Passwords for this site</p>
        <ul className="space-y-0.5">
          {logins.map((login) => (
            <li key={login.id} className="flex items-center gap-1 rounded-lg pr-1 hover:bg-foreground/5">
              <button
                type="button"
                onClick={() => fill(login)}
                title="Fill in this page"
                className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <span className="block truncate text-sm font-medium">{login.username || 'No username'}</span>
                <span className="block truncate text-xs text-muted-foreground">{login.title || 'Fill in this page'}</span>
              </button>
              {login.username && <CopyButton label="Copy username" icon={<User className="size-3.5" />} onCopy={copy(login, 'username')} />}
              <CopyButton label="Copy password" icon={<Copy className="size-3.5" />} onCopy={copy(login, 'password')} />
            </li>
          ))}
        </ul>
        <div className="border-t border-border/60 pt-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openApp('passwords', logins.length === 1 ? { item: logins[0].id, nonce: Date.now() } : undefined);
            }}
            className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-ink-accent hover:bg-foreground/5"
          >
            Open Passwords…
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
