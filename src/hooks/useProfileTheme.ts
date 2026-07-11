import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppContext } from '@/hooks/useAppContext';
import type { ProfileTheme } from '@/lib/profileTheme';

/**
 * The active profile theme (kind 16767) of the logged-in user, or `null` when
 * logged out, when the user has no theme, or when the stored theme belongs to
 * a different account.
 */
export function useProfileTheme(): ProfileTheme | null {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { theme, pubkey } = config.profileThemeMetadata;

  if (!user || !theme || pubkey !== user.pubkey) return null;
  return theme;
}
