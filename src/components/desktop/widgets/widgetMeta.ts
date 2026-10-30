import { useEffect, useState } from 'react';
import {
  BatteryMedium,
  CalendarDays,
  Clock,
  CloudSun,
  Earth,
  Globe,
  HardDrive,
  StickyNote,
  Timer,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { APP_BLOSSOM_SERVERS } from '@/lib/appBlossom';
import { getWidgetsBridge, type NappletSource, type PermissionDomain } from '@/lib/widgets';

/** Built-in widgets' icons, by their manifests' `icon`. */
export const WIDGET_ICONS: Record<string, LucideIcon> = {
  clock: Clock,
  'sticky-note': StickyNote,
  'user-round': UserRound,
  calendar: CalendarDays,
  earth: Earth,
  weather: CloudSun,
  battery: BatteryMedium,
  timer: Timer,
};

/** What each permission lets a widget do, as the user reads it. */
export const PERMISSIONS: Record<PermissionDomain, { icon: LucideIcon; title: string; description: string }> = {
  identity: {
    icon: UserRound,
    title: 'Your profile',
    description: 'See who you\'re signed in as: your profile, your relays and the people you follow.',
  },
  resource: {
    icon: Globe,
    title: 'The internet',
    description: 'Download pictures and data from the web. The sites it reaches can see your IP address.',
  },
  storage: {
    icon: HardDrive,
    title: 'Storage',
    description: 'Keep its own notes and settings on this computer.',
  },
};

/** A widget from Nostr's icon, verified against its manifest, or null while there's none. */
export function useNappletIcon(source: NappletSource | null): string | null {
  const [loaded, setLoaded] = useState<{ sha256: string; url: string } | null>(null);
  const icon = source?.icon;
  const servers = source?.servers;
  useEffect(() => {
    const bridge = getWidgetsBridge();
    if (!icon || !bridge) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    bridge.icon(icon.sha256, [...(servers ?? []), ...APP_BLOSSOM_SERVERS.servers]).then(async (bytes) => {
      const blob = new Blob([bytes as BlobPart], { type: icon.type });
      // Only what decodes as an image is shown.
      await createImageBitmap(blob);
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ sha256: icon.sha256, url: objectUrl });
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [icon, servers]);
  return loaded && loaded.sha256 === icon?.sha256 ? loaded.url : null;
}

