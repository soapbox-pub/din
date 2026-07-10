import { useCallback, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { resolveNavigation } from '@/lib/sanitizeUrl';
import type { AppComponentProps } from '@/lib/apps';

const HOME_URL = 'https://duckduckgo.com/';

/**
 * A minimal iframe-based web browser.
 *
 * Only https URLs are ever loaded (see `resolveNavigation`/`sanitizeUrl`),
 * satisfying the app's CSP (`frame-src 'self' https:`) and XSS policy. Many
 * sites send `X-Frame-Options`/`frame-ancestors` and will refuse to render;
 * that's a site-side restriction we can't override from an iframe.
 */
export function WebBrowser(_props: AppComponentProps) {
  const [address, setAddress] = useState(HOME_URL);
  const [src, setSrc] = useState(HOME_URL);
  const [history, setHistory] = useState<string[]>([HOME_URL]);
  const [cursor, setCursor] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const navigate = useCallback(
    (raw: string) => {
      const resolved = resolveNavigation(raw);
      if (!resolved) return;
      setSrc(resolved);
      setAddress(resolved);
      setHistory((h) => {
        const trimmed = h.slice(0, cursor + 1);
        setCursor(trimmed.length);
        return [...trimmed, resolved];
      });
    },
    [cursor],
  );

  const go = useCallback(
    (delta: number) => {
      const target = cursor + delta;
      if (target < 0 || target >= history.length) return;
      setCursor(target);
      setSrc(history[target]);
      setAddress(history[target]);
    },
    [cursor, history],
  );

  const reload = useCallback(() => {
    if (iframeRef.current) {
      // Re-assigning src forces a reload without dropping our history.
      iframeRef.current.src = src;
    }
  }, [src]);

  const canBack = cursor > 0;
  const canForward = cursor < history.length - 1;

  return (
    <div className="flex h-full w-full flex-col bg-neutral-950">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate(address);
        }}
        className="flex shrink-0 items-center gap-1 border-b border-white/10 bg-neutral-900 px-2 py-1.5"
      >
        <NavButton label="Go back" disabled={!canBack} onClick={() => go(-1)}>
          <ArrowLeft className="size-4" />
        </NavButton>
        <NavButton label="Go forward" disabled={!canForward} onClick={() => go(1)}>
          <ArrowRight className="size-4" />
        </NavButton>
        <NavButton label="Reload page" onClick={reload}>
          <RotateCw className="size-4" />
        </NavButton>

        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-white/40" aria-hidden />
          <input
            type="text"
            inputMode="url"
            aria-label="Address and search bar"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="Search or type a URL"
            spellCheck={false}
            autoComplete="off"
            className="h-8 w-full rounded-full border border-white/10 bg-neutral-800 pl-8 pr-3 text-sm text-white placeholder:text-white/40 focus-visible:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
          />
        </div>
      </form>

      <iframe
        ref={iframeRef}
        src={src}
        title="Web content"
        className="h-full w-full flex-1 border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

function NavButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-md text-white/80',
        'hover:bg-white/10 hover:text-white',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
        'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
      )}
    >
      {children}
    </button>
  );
}
