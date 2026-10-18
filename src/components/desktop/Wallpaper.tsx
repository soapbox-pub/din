import { useContext } from 'react';
import { MonitorsContext } from '@/contexts/MonitorsContext';
import { useProfileTheme } from '@/hooks/useProfileTheme';
import { rectStyle, viewportMonitor } from '@/lib/monitors';

/**
 * Fullscreen wallpaper backdrop shared by the login screen and desktop.
 *
 * Spans every monitor, with the image fitted to each one rather than
 * stretched across them all. `children` lay out on the primary monitor;
 * `backdrop` sits above the wallpaper on every monitor, beneath them.
 */
export function Wallpaper({
  children,
  backdrop,
}: {
  children: React.ReactNode;
  backdrop?: React.ReactNode;
}) {
  const theme = useProfileTheme();
  const layout = useContext(MonitorsContext);
  const monitors = layout?.monitors ?? [viewportMonitor()];
  const primary = layout?.primary ?? monitors[0];

  // Profile theme background (already sanitized to an https-only URL at the
  // parse layer). Video backgrounds are intentionally not rendered.
  const themeBackground =
    theme?.background && theme.background.mimeType.startsWith('image/')
      ? theme.background
      : null;

  // One image per monitor, each covering just its own screen.
  const coverImage = (src: string) =>
    monitors.map((m) => (
      <img
        key={m.id}
        src={src}
        alt=""
        aria-hidden
        draggable={false}
        style={rectStyle(m)}
        className="pointer-events-none select-none object-cover"
      />
    ));

  return (
    // Positioned over the whole window from wherever <body> sits (see
    // MonitorsProvider). overflow-clip rather than hidden: it can't be
    // scrolled, so focusing something off-screen never shifts the desktop.
    <div
      data-screen-root
      className="absolute overflow-clip bg-[#0b0f14]"
      style={{
        left: -primary.x,
        top: -primary.y,
        width: layout?.width ?? '100vw',
        height: layout?.height ?? '100vh',
      }}
    >
      {theme ? (
        // Themed: solid theme background color underneath, optional image on top.
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-background" />
      ) : (
        coverImage('/wallpaper.jpg')
      )}

      {themeBackground && themeBackground.mode === 'cover' && coverImage(themeBackground.url)}

      {themeBackground && themeBackground.mode === 'tile' && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-repeat"
          style={{ backgroundImage: `url("${themeBackground.url}")` }}
        />
      )}

      {backdrop}

      <div className="flex flex-col" style={rectStyle(primary)}>
        {children}
      </div>
    </div>
  );
}
