import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound, LockKeyhole, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { cn } from '@/lib/utils';
import { getPasswordsDesktopBridge, type PasswordOffer, type PasswordSuggestion } from '@/lib/passwords';
import { portalContainer } from '@/lib/portalContainer';
import { findGuest } from '@/platform/guest';

const LIST_WIDTH = 320;
const OFFER_WIDTH = 340;
const MARGIN = 8;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a guest is on the screen, every frame while something is anchored to
 * it, so a window being dragged takes the suggestions along. Null while the
 * guest is hidden (a background tab, a minimized window).
 */
function useGuestBox(wcId: number | null): Box | null {
  const [measured, setMeasured] = useState<{ wcId: number; box: Box | null } | null>(null);
  useLayoutEffect(() => {
    if (wcId === null) return;
    let frame = 0;
    let last = '';
    const measure = () => {
      const el = findGuest(wcId);
      const visible = !!el && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      const r = visible ? el.getBoundingClientRect() : null;
      const box = r && r.width > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
      const key = JSON.stringify(box);
      if (key !== last) {
        last = key;
        setMeasured({ wcId, box });
      }
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [wcId]);
  return measured && measured.wcId === wcId ? measured.box : null;
}

/**
 * The Web Browser's autofill, drawn by the desktop over the page (the page
 * never sees it; electron/passwords.mts):
 *
 *  - below a login field the cursor goes into, the vault's logins for the
 *    site, or a strong password for a new-password field, or Unlock while
 *    the vault is locked. The page keeps the keyboard; its preload sends the
 *    arrow keys, Enter and Escape here while the list is up;
 *  - after a login the vault doesn't have is submitted, an offer to save it
 *    at the top right of the page.
 *
 * Renders nothing outside the Electron shell.
 */
export function PasswordAutofillHost() {
  const bridge = getPasswordsDesktopBridge();
  const { open } = useWindowActions();
  const [suggestion, setSuggestion] = useState<PasswordSuggestion | null>(null);
  const [highlighted, setHighlighted] = useState(-1);
  const [offers, setOffers] = useState<PasswordOffer[]>([]);
  const suggestionRef = useRef(suggestion);
  const highlightedRef = useRef(highlighted);
  useEffect(() => {
    suggestionRef.current = suggestion;
    highlightedRef.current = highlighted;
  }, [suggestion, highlighted]);

  useEffect(() => {
    if (!bridge) return;
    const offs = [
      bridge.onSuggest((s) => {
        setSuggestion(s);
        setHighlighted(-1);
      }),
      bridge.onHide((requestId) => setSuggestion((s) => (s?.requestId === requestId ? null : s))),
      bridge.onOffer((offer) => setOffers((list) => [...list.filter((o) => o.wcId !== offer.wcId), offer])),
      bridge.onOfferGone((offerId) => setOffers((list) => list.filter((o) => o.offerId !== offerId))),
    ];
    return () => offs.forEach((off) => off());
  }, [bridge]);

  /** The rows, in order: what Enter and the arrows walk through. */
  const rows = suggestion
    ? suggestion.locked
      ? ['unlock']
      : [...(suggestion.generated ? ['generated'] : []), ...suggestion.items.map((i) => `login:${i.id}`)]
    : [];

  const pick = useCallback(
    (row: string) => {
      const s = suggestionRef.current;
      if (!bridge || !s) return;
      setSuggestion(null);
      if (row === 'unlock') {
        void bridge.choose(s.requestId, { type: 'dismiss' });
        open('passwords');
      } else if (row === 'generated') {
        void bridge.choose(s.requestId, { type: 'generated' });
      } else if (row.startsWith('login:')) {
        void bridge.choose(s.requestId, { type: 'login', id: row.slice('login:'.length) });
      }
    },
    [bridge, open],
  );

  const rowsKey = rows.join('\n');
  useEffect(() => {
    if (!bridge) return;
    return bridge.onKey(({ requestId, key }) => {
      const s = suggestionRef.current;
      if (!s || s.requestId !== requestId) return;
      const all = rowsKey.split('\n').filter(Boolean);
      if (key === 'Escape') {
        setSuggestion(null);
        void bridge.choose(requestId, { type: 'dismiss' });
        return;
      }
      const h = highlightedRef.current;
      if (key === 'Enter') {
        if (all[h]) pick(all[h]);
        return;
      }
      const next = key === 'ArrowDown' ? Math.min(all.length - 1, h + 1) : Math.max(-1, h - 1);
      highlightedRef.current = next;
      setHighlighted(next);
      void bridge.highlight(requestId, next >= 0);
    });
  }, [bridge, pick, rowsKey]);

  const box = useGuestBox(suggestion?.wcId ?? null);

  if (!bridge) return null;
  return createPortal(
    <>
      {suggestion && box && (
        <SuggestionList
          suggestion={suggestion}
          box={box}
          rows={rows}
          highlighted={highlighted}
          onHover={setHighlighted}
          onPick={pick}
          onManage={() => {
            void bridge.choose(suggestion.requestId, { type: 'dismiss' });
            setSuggestion(null);
            open('passwords');
          }}
        />
      )}
      {offers.map((offer) => (
        <OfferBubble
          key={offer.offerId}
          offer={offer}
          onAnswer={(answer, username) => {
            setOffers((list) => list.filter((o) => o.offerId !== offer.offerId));
            void bridge.answerOffer(offer.offerId, answer, username);
          }}
        />
      ))}
    </>,
    portalContainer(),
  );
}

function SuggestionList({
  suggestion,
  box,
  rows,
  highlighted,
  onHover,
  onPick,
  onManage,
}: {
  suggestion: PasswordSuggestion;
  box: Box;
  rows: string[];
  highlighted: number;
  onHover: (index: number) => void;
  onPick: (row: string) => void;
  onManage: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => setHeight(listRef.current?.offsetHeight ?? 0), [rows.length]);

  const { rect } = suggestion;
  let left: number;
  let top: number;
  let width = LIST_WIDTH;
  if (suggestion.mainFrame) {
    const field = {
      left: box.left + rect.x * box.width,
      top: box.top + rect.y * box.height,
      width: rect.width * box.width,
      bottom: box.top + (rect.y + rect.height) * box.height,
    };
    width = Math.max(LIST_WIDTH, Math.min(field.width, 420));
    left = field.left;
    // Below the field, or above it if there's no room below.
    top = field.bottom + 4;
    if (top + height > window.innerHeight - MARGIN && field.top - height - 4 > MARGIN) top = field.top - height - 4;
  } else {
    // A field inside a frame of its own: where in the page isn't known, so at its top.
    left = box.left + (box.width - width) / 2;
    top = box.top + MARGIN;
  }
  left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={`Passwords for ${suggestion.site}`}
      // Clicks here mustn't take the keyboard from the page's field.
      onMouseDown={(e) => e.preventDefault()}
      style={{ left, top, width }}
      className="fixed z-[10000] overflow-hidden rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95"
    >
      {suggestion.locked ? (
        <Row
          active={highlighted === 0}
          onHover={() => onHover(0)}
          onClick={() => onPick('unlock')}
          icon={<LockKeyhole className="size-4" />}
          title="Unlock Passwords"
          subtitle={`To fill in your password for ${suggestion.site}`}
        />
      ) : (
        rows.map((row, index) => {
          if (row === 'generated') {
            return (
              <Row
                key={row}
                active={highlighted === index}
                onHover={() => onHover(index)}
                onClick={() => onPick(row)}
                icon={<Sparkles className="size-4" />}
                title="Use Strong Password"
                subtitle={suggestion.generated ?? ''}
                mono
              />
            );
          }
          const item = suggestion.items.find((i) => `login:${i.id}` === row);
          if (!item) return null;
          return (
            <Row
              key={row}
              active={highlighted === index}
              onHover={() => onHover(index)}
              onClick={() => onPick(row)}
              icon={<KeyRound className="size-4" />}
              title={item.username || 'No username'}
              subtitle={item.title || suggestion.site}
            />
          );
        })
      )}
      <div className="mt-1 border-t border-border/60 pt-1">
        <button
          type="button"
          onClick={onManage}
          className="w-full rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          Open Passwords…
        </button>
      </div>
    </div>
  );
}

function Row({
  active,
  onHover,
  onClick,
  icon,
  title,
  subtitle,
  mono,
}: {
  active: boolean;
  onHover: () => void;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left',
        active ? 'bg-primary text-primary-foreground' : 'hover:bg-foreground/10',
      )}
    >
      <span
        aria-hidden
        className={cn('grid size-8 shrink-0 place-items-center rounded-lg', active ? 'bg-primary-foreground/15' : 'bg-primary/10 text-primary')}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className={cn('block truncate text-xs', mono && 'font-mono', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
          {subtitle}
        </span>
      </span>
    </button>
  );
}

function OfferBubble({
  offer,
  onAnswer,
}: {
  offer: PasswordOffer;
  onAnswer: (answer: 'save' | 'never' | 'dismiss', username?: string) => void;
}) {
  const box = useGuestBox(offer.wcId);
  const [username, setUsername] = useState(offer.username);
  if (!box) return null;
  const width = Math.min(OFFER_WIDTH, box.width - 2 * MARGIN);
  const left = Math.max(MARGIN, box.left + box.width - width - MARGIN);
  const top = box.top + MARGIN;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onAnswer('save', username);
  };
  return (
    <form
      role="dialog"
      aria-label={offer.update ? `Update your password for ${offer.site}` : `Save your password for ${offer.site}`}
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onAnswer('dismiss');
        }
      }}
      style={{ left, top, width }}
      className="fixed z-[10000] space-y-3 rounded-xl border border-border/60 bg-popover p-4 text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2"
    >
      <div className="flex items-start gap-3">
        <img src="/icons/apps/passwords.png" alt="" className="size-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{offer.update ? 'Update your password?' : 'Save this password?'}</p>
          <p className="truncate text-xs text-muted-foreground">
            {offer.update ? `For ${offer.username || 'your account'} on ${offer.site}` : `For ${offer.site}, in Passwords`}
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" className="-mt-1 -mr-1 size-7" aria-label="Not now" onClick={() => onAnswer('dismiss')}>
          <X className="size-4" />
        </Button>
      </div>
      {!offer.update && (
        <Input
          aria-label="Username"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="h-8"
        />
      )}
      <div className="flex items-center justify-end gap-2">
        {!offer.update && (
          <Button type="button" variant="ghost" size="sm" className="mr-auto px-2 text-muted-foreground" onClick={() => onAnswer('never')}>
            Never for This Site
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={() => onAnswer('dismiss')}>
          Not Now
        </Button>
        <Button type="submit" size="sm">
          {offer.update ? 'Update' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
