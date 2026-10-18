import { LoginArea } from '@/components/auth/LoginArea';
import { Wallpaper } from './Wallpaper';
import { ScreenLayer } from './MonitorsProvider';
import { useClock } from '@/hooks/useClock';

/**
 * Lock-screen style login. Shown whenever no Nostr account is logged in.
 * All login methods (new account, extension, nsec, bunker) are handled by
 * LoginArea's AuthDialog.
 */
export function LoginScreen() {
  const now = useClock();

  return (
    <Wallpaper
      backdrop={
        // Darken the wallpaper slightly so the clock reads well. Every
        // monitor dims; the clock and sign-in sit on the primary one.
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-black/30" />
      }
    >
      <main className="relative flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <time
          dateTime={now.toISOString()}
          className="text-7xl font-semibold tabular-nums tracking-tight text-white md:text-8xl"
        >
          {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>

        <p className="text-lg text-white/70 md:text-xl">
          {now.toLocaleDateString([], {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          })}
        </p>

        <div className="mt-12 flex flex-col items-center gap-4">
          <LoginArea />
          <p className="max-w-xs text-sm text-white/50">
            Sign in with your Nostr account to start your session.
          </p>
        </div>
      </main>

      <footer className="relative pb-6 text-center text-sm font-medium tracking-widest text-white/40 uppercase">
        Din
      </footer>

      {/* Boot veil: fades the login screen in from black, on every
          monitor. Masks the wallpaper decode and font swap on the first
          painted frame, and plays again whenever the session returns to the
          login screen. */}
      <ScreenLayer
        aria-hidden
        className="pointer-events-none z-50 animate-veil-out bg-black motion-reduce:animate-none motion-reduce:opacity-0"
      />
    </Wallpaper>
  );
}
