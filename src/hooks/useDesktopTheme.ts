import { useCallback, useMemo } from 'react';
import type { AppConfig } from '@/contexts/AppContext';
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

/** What `snapshot` saves for `restore`. */
export interface ThemeSnapshot {
  mode: AppearanceMode;
  theme: DesktopTheme | null;
  config: Pick<
    AppConfig,
    'theme' | 'customThemeEnabled' | 'syncProfileTheme' | 'localTheme' | 'profileThemeMetadata'
  >;
  /** publishCount when it was taken. */
  published: number;
  /** Whether an edit was waiting to be published then. */
  pending: boolean;
}

/** How long edits settle (a color being dragged) before the profile theme is published. */
const PUBLISH_DELAY_MS = 1500;

/**
 * How long a theme tried on (clicking around the App Store's themes) is
 * held before it's published, unless it's committed or discarded first.
 */
const HOLD_DELAY_MS = 30_000;

let publishTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPublish: (() => Promise<unknown>) | undefined;
/** How many profile themes have gone out, so a restore can tell whether one has since. */
let publishCount = 0;

function runPublish() {
  const publish = pendingPublish;
  clearTimeout(publishTimer);
  pendingPublish = undefined;
  if (!publish) return;
  publishCount++;
  publish().catch((error: unknown) => {
    console.error('Failed to publish profile theme:', error);
    toast({
      title: "Couldn't update your profile theme",
      description: error instanceof Error ? error.message : String(error),
      variant: 'destructive',
    });
  });
}

/**
 * Publish the latest of a run of edits, once they settle, or with a null
 * delay only once it's committed.
 */
function schedulePublish(publish: () => Promise<unknown>, delay: number | null = PUBLISH_DELAY_MS) {
  clearTimeout(publishTimer);
  pendingPublish = publish;
  if (delay !== null) publishTimer = setTimeout(runPublish, delay);
}

/** How long `apply` waits to publish: until it settles, a while, or a commit. */
type Hold = boolean | 'until-commit';

function holdDelay(hold: Hold): number | null {
  if (hold === 'until-commit') return null;
  return hold ? HOLD_DELAY_MS : PUBLISH_DELAY_MS;
}

function cancelPublish() {
  clearTimeout(publishTimer);
  pendingPublish = undefined;
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

  /**
   * Wear a theme as the profile theme now, and publish it once edits
   * settle, or with `hold` once it's committed or HOLD_DELAY_MS passes
   * ('until-commit': only once it's committed).
   */
  const applyProfile = useCallback(
    (next: ProfileTheme, { hold = false }: { hold?: Hold } = {}) => {
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
          tags: buildProfileThemeTags(next, pubkey),
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
      }, holdDelay(hold));
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
   * `hold` is for clicking around themes: it goes out on `commit`, or once
   * a while passes, not as soon as it settles. A theme tried on is held
   * 'until-commit', so it never goes out by itself.
   */
  const apply = useCallback(
    (next: DesktopTheme, options?: { hold?: Hold }) => {
      if (syncing) {
        const asProfile = toProfileTheme(next);
        if (!asProfile) throw new Error('A background on this computer can’t go in your profile theme.');
        applyProfile(asProfile, options);
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

  /**
   * Change the custom theme worn by hand. A theme taken from someone else
   * stops crediting them; one of the user's own keeps its name, so it can
   * be updated. `local` keeps it on this computer, as applyLocal does.
   */
  const edit = useCallback(
    (next: DesktopTheme, { local = false }: { local?: boolean } = {}) => {
      const own = next.source && next.source.pubkey === pubkey;
      const edited = own ? next : { ...next, source: undefined };
      if (local) applyLocal(edited);
      else apply(edited);
    },
    [apply, applyLocal, pubkey],
  );

  /** What's worn now, to put back later with `restore` (Undo). */
  const snapshot = useCallback(
    (): ThemeSnapshot => ({
      mode,
      theme,
      config: {
        theme: config.theme,
        customThemeEnabled: config.customThemeEnabled,
        syncProfileTheme: config.syncProfileTheme,
        localTheme: config.localTheme,
        profileThemeMetadata: config.profileThemeMetadata,
      },
      published: publishCount,
      pending: !!pendingPublish,
    }),
    [mode, theme, config],
  );

  /**
   * Put back a snapshot. While nothing has been published since it was
   * taken, what's waiting to go out is dropped and the settings put back as
   * they were, so the profile theme on relays never changes.
   */
  const restore = useCallback(
    (saved: ThemeSnapshot) => {
      if (saved.published === publishCount && !saved.pending) {
        cancelPublish();
        updateConfig((current) => ({ ...current, ...saved.config }));
      } else if (saved.theme) {
        apply(saved.theme);
      } else {
        setMode(saved.mode);
      }
    },
    [apply, setMode, updateConfig],
  );

  /** Publish now whatever `apply` with `hold` is holding back. */
  const commit = useCallback(() => runPublish(), []);

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
      edit,
      snapshot,
      restore,
      commit,
      setMode,
      setSync,
    }),
    [
      theme,
      mode,
      syncing,
      canSync,
      syncProfileTheme,
      base,
      apply,
      applyLocal,
      edit,
      snapshot,
      restore,
      commit,
      setMode,
      setSync,
    ],
  );
}
