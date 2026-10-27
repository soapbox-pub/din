import { Bell, Camera, MapPin, Mic, RefreshCw, type LucideIcon } from 'lucide-react';
import type { SiteCapability } from '@/lib/promptBridge';

/** How a capability a site asks for is named and drawn, in prompts and site info. */
export const SITE_CAPABILITIES: Record<SiteCapability, { name: string; label: string; icon: LucideIcon }> = {
  camera: { name: 'Camera', label: 'Use your camera', icon: Camera },
  microphone: { name: 'Microphone', label: 'Use your microphone', icon: Mic },
  geolocation: { name: 'Location', label: 'Know your location', icon: MapPin },
  notifications: { name: 'Notifications', label: 'Show notifications', icon: Bell },
  'background-sync': { name: 'Background refresh', label: 'Refresh in the background', icon: RefreshCw },
};
