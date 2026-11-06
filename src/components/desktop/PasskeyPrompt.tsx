import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { getPasskeysBridge, type PasskeyAnswer, type PasskeyRequest } from '@/lib/passkeys';
import { portalContainer } from '@/lib/portalContainer';
import { findGuest } from '@/platform/guest';
import { useGuestBox } from './guestBox';

const WIDTH = 380;
const MARGIN = 8;

/**
 * The Web Browser's passkeys, asked about over the page that wants one
 * (electron/passkeys.mts): save a new passkey in Passwords, or pick the
 * account to sign in with. One per tab, at the top of its page, going along
 * with its window; the page waits on the answer, and closing this tells it
 * no. Not a dialog: Passwords may need unlocking in its own window first,
 * and the rest of the desktop stays usable meanwhile.
 *
 * Renders nothing outside the Electron shell.
 */
export function PasskeyPrompt() {
  const bridge = getPasskeysBridge();
  const [requests, setRequests] = useState<PasskeyRequest[]>([]);

  useEffect(() => {
    if (!bridge) return;
    const put = (request: PasskeyRequest) =>
      setRequests((list) => [...list.filter((r) => r.requestId !== request.requestId && r.wcId !== request.wcId), request]);
    const offs = [
      bridge.onRequest(put),
      bridge.onGone((requestId) => setRequests((list) => list.filter((r) => r.requestId !== requestId))),
    ];
    void bridge.pending().then((list) => list.forEach(put)).catch(() => {});
    return () => offs.forEach((off) => off());
  }, [bridge]);

  if (!bridge) return null;
  return createPortal(
    <>
      {requests.map((request) => (
        <Prompt
          key={request.requestId}
          request={request}
          onAnswer={(answer) => {
            if (answer.type === 'cancel' || answer.type === 'security-key') {
              setRequests((list) => list.filter((r) => r.requestId !== request.requestId));
            }
            // Back to the page, which carries on from here.
            findGuest(request.wcId)?.focus();
            return bridge.answer(request.requestId, answer);
          }}
        />
      ))}
    </>,
    portalContainer(),
  );
}

function Prompt({ request, onAnswer }: { request: PasskeyRequest; onAnswer: (answer: PasskeyAnswer) => Promise<void> }) {
  const { open } = useWindowActions();
  const box = useGuestBox(request.wcId);
  const [busy, setBusy] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const shown = !!box;

  // The page asked, so it had the keyboard: the prompt takes it, for Enter and Escape.
  useEffect(() => {
    if (!shown) return;
    const guest = findGuest(request.wcId);
    if (guest && document.activeElement === guest) primaryRef.current?.focus();
  }, [shown, request.wcId, request.vault]);

  if (!box) return null;
  const width = Math.min(WIDTH, box.width - 2 * MARGIN);
  const left = Math.max(MARGIN, box.left + (box.width - width) / 2);
  const top = box.top + MARGIN;

  const answer = (a: PasskeyAnswer) => {
    if (busy) return;
    if (a.type === 'create' || a.type === 'get') setBusy(true);
    void onAnswer(a).catch(() => setBusy(false));
  };
  const cancel = () => answer({ type: 'cancel' });
  const securityKey = (
    <Button type="button" variant="ghost" size="sm" className="mr-auto px-2 text-muted-foreground" disabled={busy} onClick={() => answer({ type: 'security-key' })}>
      Use a Security Key
    </Button>
  );

  const { site } = request;
  const account = request.username || 'your account';
  let title: string;
  let subtitle: string;
  let body: React.ReactNode = null;
  let actions: React.ReactNode;

  if (request.vault !== 'open') {
    const missing = request.vault === 'missing';
    title = request.kind === 'create' ? `Save a passkey for ${site}?` : `Sign in to ${site} with a passkey`;
    subtitle = missing ? 'Passkeys are kept in Passwords. Set it up first.' : 'Your passkeys are in Passwords. Unlock it first.';
    actions = (
      <>
        {securityKey}
        <Button type="button" variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
        <Button ref={primaryRef} type="button" size="sm" onClick={() => open('passwords')}>
          {missing ? 'Set Up Passwords' : 'Unlock Passwords'}
        </Button>
      </>
    );
  } else if (request.kind === 'create' && request.excluded) {
    title = `You already have a passkey for ${site}`;
    subtitle = `For ${account}, in Passwords`;
    actions = (
      <Button ref={primaryRef} type="button" size="sm" onClick={cancel}>OK</Button>
    );
  } else if (request.kind === 'create') {
    title = request.replaces ? `Replace your passkey for ${site}?` : `Save a passkey for ${site}?`;
    subtitle = request.replaces
      ? `The one Passwords has for ${account} stops working.`
      : `For ${account}, in Passwords. You sign in with it instead of a password.`;
    actions = (
      <>
        {securityKey}
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={cancel}>Cancel</Button>
        <Button ref={primaryRef} type="button" size="sm" disabled={busy} onClick={() => answer({ type: 'create' })}>
          {request.replaces ? 'Replace' : 'Save Passkey'}
        </Button>
      </>
    );
  } else if (request.accounts.length > 0) {
    title = `Sign in to ${site}`;
    subtitle = request.accounts.length === 1 ? 'With your passkey from Passwords' : 'With a passkey from Passwords. Pick the account.';
    body = (
      <div role="listbox" aria-label={`Passkeys for ${site}`} className="-mx-1 space-y-0.5">
        {request.accounts.map((a, index) => (
          <button
            key={a.id}
            ref={index === 0 ? primaryRef : undefined}
            type="button"
            role="option"
            aria-selected={false}
            disabled={busy}
            onClick={() => answer({ type: 'get', id: a.id })}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60"
          >
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-pigment text-primary-foreground clay-pigment">
              <KeyRound className="size-4.5" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{a.username || 'No username'}</span>
              <span className="block truncate text-xs text-muted-foreground">{a.title || site}</span>
            </span>
          </button>
        ))}
      </div>
    );
    actions = (
      <>
        {securityKey}
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={cancel}>Cancel</Button>
      </>
    );
  } else {
    title = `No passkey for ${site}`;
    subtitle = 'Passwords has none for this site. A security key may have one.';
    actions = (
      <>
        <Button type="button" variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
        <Button ref={primaryRef} type="button" size="sm" onClick={() => answer({ type: 'security-key' })}>
          Use a Security Key
        </Button>
      </>
    );
  }

  return (
    <div
      role="dialog"
      aria-label={title}
      aria-describedby={`passkey-${request.requestId}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
      style={{ left, top, width }}
      className="fixed z-[10000] glass-surface space-y-3 rounded-xl p-4 text-popover-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2"
    >
      <div className="flex items-start gap-3">
        <img src="/icons/apps/passwords.png" alt="" className="size-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold break-words">{title}</p>
          <p id={`passkey-${request.requestId}`} className="text-xs text-muted-foreground break-words">{subtitle}</p>
        </div>
        <Button type="button" variant="ghost" size="icon" className="-mt-1 -mr-1 size-7" aria-label="Cancel" disabled={busy} onClick={cancel}>
          <X className="size-4" />
        </Button>
      </div>
      {body}
      <div className="flex items-center justify-end gap-2">{actions}</div>
    </div>
  );
}
