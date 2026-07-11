import { useProfileTheme } from '@/hooks/useProfileTheme';

/** Fullscreen wallpaper backdrop shared by the login screen and desktop. */
export function Wallpaper({ children }: { children: React.ReactNode }) {
  const theme = useProfileTheme();

  // Profile theme background (already sanitized to an https-only URL at the
  // parse layer). Video backgrounds are intentionally not rendered.
  const themeBackground =
    theme?.background && theme.background.mimeType.startsWith('image/')
      ? theme.background
      : null;

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#0b0f14]">
      {theme ? (
        // Themed: solid theme background color underneath, optional image on top.
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-background" />
      ) : (
        <img
          src="/wallpaper.jpg"
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
        />
      )}

      {themeBackground && themeBackground.mode === 'cover' && (
        <img
          src={themeBackground.url}
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
        />
      )}

      {themeBackground && themeBackground.mode === 'tile' && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-repeat"
          style={{ backgroundImage: `url("${themeBackground.url}")` }}
        />
      )}

      {children}
    </div>
  );
}
