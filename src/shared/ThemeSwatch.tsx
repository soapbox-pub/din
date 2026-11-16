import { useMemo, type CSSProperties } from 'react';
import { deriveThemeTokens, type DesktopTheme } from '@/lib/profileTheme';
import { cn } from '@/lib/utils';

/**
 * A theme drawn as a little desktop: its background and picture, a window
 * with text, and an accent button, all in the theme's own tokens (scoped to
 * this element, so nothing else changes). Fonts aren't loaded for it.
 *
 * Every value comes from a parsed, sanitized theme (src/lib/profileTheme.ts),
 * so the colors are hex and the picture's URL is safe inside `url("…")`.
 */
export function ThemeSwatch({ theme, className }: { theme: DesktopTheme; className?: string }) {
  const style = useMemo(() => {
    const tokens: Record<string, string> = deriveThemeTokens(theme.colors);
    const background = theme.background?.mimeType.startsWith('image/') ? theme.background : null;
    return {
      ...tokens,
      backgroundColor: theme.colors.background,
      backgroundImage: background ? `url("${background.url}")` : undefined,
      backgroundSize: background?.mode === 'tile' ? 'auto' : 'cover',
      backgroundRepeat: background?.mode === 'tile' ? 'repeat' : 'no-repeat',
      backgroundPosition: 'center',
    } as CSSProperties;
  }, [theme.colors, theme.background]);

  return (
    <div
      aria-hidden
      style={style}
      className={cn('pointer-events-none relative aspect-video overflow-hidden text-foreground', className)}
    >
      <div className="absolute inset-x-[12%] top-[14%] bottom-[22%] flex flex-col overflow-hidden rounded-md border border-border bg-card shadow-sm">
        <div className="flex h-[16%] min-h-2 items-center gap-[3%] border-b border-border bg-muted px-[4%]">
          <span className="size-[0.35rem] rounded-full bg-muted-foreground/60" />
          <span className="size-[0.35rem] rounded-full bg-muted-foreground/60" />
          <span className="size-[0.35rem] rounded-full bg-muted-foreground/60" />
        </div>
        <div className="flex flex-1 flex-col justify-center gap-[8%] px-[8%]">
          <span className="h-[12%] w-3/5 rounded-full bg-foreground" />
          <span className="h-[8%] w-4/5 rounded-full bg-muted-foreground" />
          <span className="h-[8%] w-2/3 rounded-full bg-muted-foreground" />
          <span className="mt-[2%] h-[18%] w-1/3 rounded-full bg-primary" />
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 flex h-[12%] items-center justify-center gap-[2%] bg-card/85">
        <span className="aspect-square h-1/2 rounded-sm bg-primary" />
        <span className="aspect-square h-1/2 rounded-sm bg-muted-foreground/60" />
        <span className="aspect-square h-1/2 rounded-sm bg-muted-foreground/60" />
      </div>
    </div>
  );
}
