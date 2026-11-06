import { useMemo, useState, type FormEvent } from 'react';
import { Check, Eye, EyeOff, Keyboard, Loader2, Search } from 'lucide-react';
import {
  useKeyboardLayouts,
  useKeyboardStatus,
  useRestartForKeyboardLayout,
  useSetKeyboardLayout,
} from '@/hooks/useKeyboardLayout';
import { getEraseBridge } from '@/lib/erase';
import { passphraseProblem } from '@/lib/installer';
import { layoutKey } from '@/lib/keyboard';
import { cleanLockError } from '@/lib/lock';
import { cn } from '@/lib/utils';
import { Wallpaper } from './Wallpaper';

type Step = 'welcome' | 'password' | 'saving';

/**
 * Setup: what an erased DinOS computer shows in place of the desktop until
 * it has a password (os/din-erase.sh, window.dinos.erase). The keyboard
 * layout comes first, since the password is typed at the boot screen with
 * it, then the password, which din-password sets everywhere the computer's
 * is kept. It looks like the boot screen it follows: the wallpaper (Din's
 * own, on an erased computer), dimmed, a large heading, the same fields,
 * and Din's logo in the same place at the foot, where BootVeil hands over.
 */
export function Setup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [error, setError] = useState<string | null>(null);

  const save = (password: string) => {
    const bridge = getEraseBridge();
    if (!bridge) return;
    setStep('saving');
    setError(null);
    bridge
      .setUp(password)
      .then(onDone)
      .catch((e: unknown) => {
        setError(cleanLockError(e));
        setStep('password');
      });
  };

  return (
    <Wallpaper backdrop={<div aria-hidden className="pointer-events-none absolute inset-0 bg-black/55" />}>
      <main
        className="fixed inset-0 overflow-y-auto text-white [container-type:size]"
        aria-labelledby="setup-title"
      >
        <div className="mx-auto flex min-h-full w-full max-w-lg flex-col items-center justify-center gap-8 px-6 pb-32 pt-16">
          {step === 'welcome' && <WelcomeStep onContinue={() => setStep('password')} />}
          {step === 'password' && <PasswordStep error={error} onSubmit={save} />}
          {step === 'saving' && (
            <div className="flex flex-col items-center gap-4 text-center" role="status">
              <Loader2 className="size-8 text-white/80 motion-safe:animate-spin" aria-hidden />
              <h1 id="setup-title" className="text-4xl font-light tracking-tight">Setting up…</h1>
              <p className="text-lg text-white/70">Giving the disk, the lock screen and your accounts the password.</p>
            </div>
          )}
        </div>
        <img
          src="/din-logo.svg"
          alt=""
          className="pointer-events-none absolute bottom-[3.7cqh] left-1/2 h-[2.59cqh] -translate-x-1/2 opacity-85"
        />
      </main>
    </Wallpaper>
  );
}

function Heading({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <h1 id="setup-title" className="text-5xl font-light tracking-tight">{title}</h1>
      <p className="text-lg text-white/70">{children}</p>
    </div>
  );
}

const fieldClass =
  'h-12 w-full rounded-full border border-white/30 bg-white/[0.14] px-5 text-lg text-white placeholder:text-white/50 ' +
  'outline-none focus-visible:border-white/70 focus-visible:ring-2 focus-visible:ring-white/40 aria-invalid:border-red-300';

const primaryButtonClass =
  'inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-8 text-lg font-medium text-[#0b0f14] ' +
  'transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0f14] disabled:cursor-not-allowed disabled:opacity-50';

/** Welcome, and the keyboard layout the password will be typed with. */
function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  const status = useKeyboardStatus();
  const restart = useRestartForKeyboardLayout();
  const restartNeeded = status.data?.restartNeeded === true;

  return (
    <>
      <Heading title="Welcome to DinOS">Let’s set up this computer.</Heading>
      {status.data?.canChange && <LayoutPicker />}
      {restartNeeded && (
        <p className="text-center text-base text-white/70">
          Din restarts to type with the new layout, then setup goes on.
        </p>
      )}
      <button
        type="button"
        className={primaryButtonClass}
        disabled={status.isLoading || restart.isPending}
        onClick={() => (restartNeeded ? restart.mutate() : onContinue())}
      >
        {restart.isPending && <Loader2 className="size-5 motion-safe:animate-spin" aria-hidden />}
        Continue
      </button>
      {restart.isError && (
        <p role="alert" className="text-center text-base text-red-300">
          {restart.error instanceof Error ? restart.error.message : 'Could not restart Din.'}
        </p>
      )}
    </>
  );
}

function LayoutPicker() {
  const status = useKeyboardStatus();
  const layouts = useKeyboardLayouts();
  const setLayout = useSetKeyboardLayout();
  const [query, setQuery] = useState('');
  const [choosing, setChoosing] = useState(false);

  const selected = setLayout.isPending ? setLayout.variables : status.data?.layout ?? null;
  const selectedKey = selected ? layoutKey(selected) : null;
  const current = status.data?.layout;

  const filtered = useMemo(() => {
    const all = layouts.data ?? [];
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return all;
    return all.filter((entry) => {
      const haystack = `${entry.name} ${entry.layout} ${entry.variant}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [layouts.data, query]);

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center gap-3 rounded-2xl border border-white/20 bg-white/[0.08] px-5 py-4">
        <Keyboard className="size-5 shrink-0 text-white/70" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-white/60">Keyboard</p>
          <p className="truncate text-lg">{current?.name ?? '…'}</p>
        </div>
        {!choosing && (
          <button
            type="button"
            onClick={() => setChoosing(true)}
            className="rounded-full px-4 py-2 text-base text-white/90 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            Change
          </button>
        )}
      </div>
      {choosing && (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-white/50" aria-hidden />
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search layouts"
              aria-label="Search keyboard layouts"
              className={cn(fieldClass, 'pl-12')}
            />
          </div>
          <div
            role="radiogroup"
            aria-label="Keyboard layout"
            className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-2xl border border-white/20 bg-white/[0.06] p-1 [&>*]:shrink-0"
          >
            {layouts.isLoading ? (
              <p className="px-4 py-3 text-base text-white/60">Loading layouts…</p>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-3 text-base text-white/60">No layouts match your search.</p>
            ) : (
              filtered.map((entry) => {
                const key = layoutKey(entry);
                const active = key === selectedKey;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      if (!active) setLayout.mutate({ layout: entry.layout, variant: entry.variant });
                    }}
                    className={cn(
                      'flex items-center gap-3 rounded-xl px-3 py-2 text-left text-base',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
                      active ? 'bg-white/15' : 'hover:bg-white/10',
                    )}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
                      {active && <Check className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
      {setLayout.isError && (
        <p role="alert" className="text-center text-base text-red-300">
          {setLayout.error instanceof Error ? setLayout.error.message : 'Could not change the keyboard layout.'}
        </p>
      )}
    </div>
  );
}

/** The computer's one password, typed twice. */
function PasswordStep({ error, onSubmit }: { error: string | null; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [shown, setShown] = useState(false);
  const problem = password ? passphraseProblem(password) : null;
  const mismatch = repeat.length > 0 && repeat !== password;
  const ready = password.length > 0 && problem === null && repeat === password;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) onSubmit(password);
  };

  return (
    <form className="flex w-full flex-col items-center gap-8" onSubmit={submit}>
      <Heading title="Choose a password">
        You’ll type it each time the computer starts, on the lock screen, and when something runs
        as administrator.
      </Heading>
      <div className="flex w-full flex-col gap-3">
        <div className="relative">
          <input
            type={shown ? 'text' : 'password'}
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            aria-label="Password"
            aria-invalid={problem ? true : undefined}
            aria-describedby="setup-password-hint"
            className={cn(fieldClass, 'pr-14')}
          />
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? 'Hide password' : 'Show password'}
            aria-pressed={shown}
            className="absolute right-2 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            {shown ? <EyeOff className="size-5" aria-hidden /> : <Eye className="size-5" aria-hidden />}
          </button>
        </div>
        <input
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          placeholder="Type it again"
          aria-label="Type it again"
          aria-invalid={mismatch ? true : undefined}
          className={fieldClass}
        />
        <p id="setup-password-hint" className={cn('px-5 text-base', problem || mismatch ? 'text-red-300' : 'text-white/60')}>
          {problem ?? (mismatch ? 'The passwords don’t match.' : 'At least 8 characters.')}
        </p>
      </div>
      <p className="rounded-2xl border border-white/15 bg-white/[0.06] px-5 py-4 text-center text-base text-white/80">
        It can’t be recovered. If you forget it, the computer has to be erased.
      </p>
      {error && (
        <p role="alert" className="text-center text-base text-red-300">
          {error}
        </p>
      )}
      <button type="submit" className={primaryButtonClass} disabled={!ready}>
        Continue
      </button>
    </form>
  );
}
