import { useCallback, useMemo } from 'react';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useProfileTheme } from '@/hooks/useProfileTheme';
import { toast } from '@/hooks/useToast';
import {
  ACTIVE_PROFILE_THEME_KIND,
  PRESET_THEME_COLORS,
  buildProfileThemeTags,
  isLocalBackground,
  toProfileTheme,
  type DesktopTheme,
  type ProfileTheme,
} from '@/lib/profileTheme';

/**
 * The custom theme the desktop wears, or `null` for the built-in light or
 * dark one: the profile theme while it's synced, else the one kept on this
 * computer.
 */
export function useDesktopTheme(): DesktopTheme | null {
  const profileTheme = useProfileTheme();
  const { config } = useAppContext();
  if (!config.customThemeEnabled) return null;
  return config.syncProfileTheme ? profileTheme : config.localTheme;
}

export type AppearanceMode = 'light' | 'dark' | 'custom';

/** How long edits settle (a color being dragged) before the profile theme is published. */
const PUBLISH_DELAY_MS = 1500;

let publishTimer: ReturnType<typeof setTimeout> | undefined;

/** Publish the latest of a run of edits, once they settle. */
function schedulePublish(publish: () => Promise<unknown>) {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publish().catch((error: unknown) => {
      console.error('Failed to publish profile theme:', error);
      toast({
        title: "Couldn't update your profile theme",
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    });
  }, PUBLISH_DELAY_MS);
}

/** The built-in mode in effect, with `system` resolved. */
function resolvedMode(theme: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Reads and changes the desktop's look: the built-in light and dark themes,
 * a custom one, and whether the custom one is the profile theme (kind 16767,
 * published on every change) or kept on this computer.
 */
export function useDesktopThemeEditor() {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const profileTheme = useProfileTheme();
  const theme = useDesktopTheme();
  const { mutateAsync: publishEvent } = useNostrPublish();

  /** Whether edits go to the profile theme. */
  const syncing = config.syncProfileTheme && !!user;
  const mode: AppearanceMode = theme ? 'custom' : resolvedMode(config.theme);
  const pubkey = user?.pubkey;

  /** Wear a theme as the profile theme now, and publish it once edits settle. */
  const applyProfile = useCallback(
    (next: ProfileTheme) => {
      if (!pubkey) return;
      // updatedAt stays put until the event is out, so NostrSync doesn't
      // look the theme up again on every edit.
      updateConfig((current) => ({
        ...current,
        customThemeEnabled: true,
        profileThemeMetadata: {
          theme: next,
          pubkey,
          updatedAt:
            current.profileThemeMetadata?.pubkey === pubkey ? current.profileThemeMetadata.updatedAt : 0,
        },
      }));
      schedulePublish(async () => {
        const event = await publishEvent({
          kind: ACTIVE_PROFILE_THEME_KIND,
          content: '',
          tags: buildProfileThemeTags(next),
        });
        updateConfig((current) =>
          current.profileThemeMetadata?.pubkey === event.pubkey
            ? {
                ...current,
                profileThemeMetadata: {
                  ...current.profileThemeMetadata,
                  updatedAt: Math.max(current.profileThemeMetadata.updatedAt, event.created_at),
                },
              }
            : current,
        );
      });
    },
    [pubkey, updateConfig, publishEvent],
  );

  /** Wear a theme kept on this computer, no longer syncing the profile theme. */
  const applyLocal = useCallback(
    (next: DesktopTheme) => {
      updateConfig((current) => ({
        ...current,
        customThemeEnabled: true,
        syncProfileTheme: false,
        localTheme: next,
      }));
    },
    [updateConfig],
  );

  /**
   * Wear a custom theme: the profile theme while syncing, else this
   * computer's. A theme with a local background can't be the profile theme.
   */
  const apply = useCallback(
    (next: DesktopTheme) => {
      if (syncing) {
        const asProfile = toProfileTheme(next);
        if (!asProfile) throw new Error('A background on this computer can’t go in your profile theme.');
        applyProfile(asProfile);
      } else {
        applyLocal(next);
      }
    },
    [syncing, applyProfile, applyLocal],
  );

  /**
   * The custom theme to edit: the one worn, or else the one there is to
   * wear, or else one made from the built-in theme in effect.
   */
  const base = useCallback((): DesktopTheme => {
    const stored = syncing ? profileTheme : config.localTheme;
    return theme ?? stored ?? { colors: PRESET_THEME_COLORS[resolvedMode(config.theme)], fonts: {} };
  }, [theme, syncing, profileTheme, config.localTheme, config.theme]);

  const setMode = useCallback(
    (next: AppearanceMode) => {
      if (next !== 'custom') {
        updateConfig((current) => ({ ...current, theme: next, customThemeEnabled: false }));
        return;
      }
      const stored = syncing ? profileTheme : config.localTheme;
      if (stored) updateConfig((current) => ({ ...current, customThemeEnabled: true }));
      else apply(base());
    },
    [syncing, profileTheme, config.localTheme, updateConfig, apply, base],
  );

  const setSync = useCallback(
    (on: boolean) => {
      if (!on) {
        // Keep wearing what's worn, now as this computer's own.
        updateConfig((current) => ({
          ...current,
          syncProfileTheme: false,
          localTheme: profileTheme ?? current.localTheme,
        }));
        return;
      }
      updateConfig((current) => ({ ...current, syncProfileTheme: true }));
      // With no profile theme yet, this computer's becomes it, minus any
      // background on this computer, which only a fresh choice uploads.
      const local = config.localTheme;
      if (profileTheme || !local || !pubkey) return;
      const keepsBackground = !local.background || !isLocalBackground(local.background.url);
      const asProfile = toProfileTheme(keepsBackground ? local : { ...local, background: undefined });
      if (asProfile) applyProfile(asProfile);
      if (!keepsBackground) {
        toast({
          title: 'Background left on this computer',
          description: 'Choose the picture again to upload it to your profile theme.',
        });
      }
    },
    [config.localTheme, profileTheme, pubkey, updateConfig, applyProfile],
  );

  const canSync = !!user;
  const syncProfileTheme = config.syncProfileTheme;

  return useMemo(
    () => ({
      /** The custom theme worn, or null for a built-in one. */
      theme,
      mode,
      /** Whether edits go to the profile theme. */
      syncing,
      /** Whether there's a profile theme to sync with (someone is logged in). */
      canSync,
      syncProfileTheme,
      base,
      apply,
      applyLocal,
      setMode,
      setSync,
    }),
    [theme, mode, syncing, canSync, syncProfileTheme, base, apply, applyLocal, setMode, setSync],
  );
}
