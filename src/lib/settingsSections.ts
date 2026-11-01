import {
  BatteryFull,
  Bell,
  Bluetooth,
  Bot,
  Bug,
  Clock,
  Cloud,
  Dock,
  Info,
  KeyRound,
  Keyboard,
  LayoutDashboard,
  Link2,
  Monitor,
  Palette,
  Printer,
  Smartphone,
  Sun,
  Volume2,
  Wifi,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { matchesAll } from '@/lib/settingsSearch';
import { WM_BINDING_HELP } from '@/lib/wmBindings';

export type SectionId =
  | 'wifi'
  | 'bluetooth'
  | 'phone'
  | 'display'
  | 'brightness'
  | 'power'
  | 'sound'
  | 'keyboard'
  | 'printers'
  | 'datetime'
  | 'password'
  | 'notifications'
  | 'nostr'
  | 'connected'
  | 'assistant'
  | 'appearance'
  | 'windows'
  | 'dock'
  | 'developers'
  | 'about';

export type SectionGroup = 'Connections' | 'Personal' | 'Devices' | 'Account' | 'System';

export interface SettingsSection {
  id: SectionId;
  name: string;
  icon: LucideIcon;
  group: SectionGroup;
  search: string[];
}

/**
 * The sections, in sidebar order, under their group's heading; a group's
 * sections stay together. `search` is what Settings search matches
 * besides the name: the section's headings and setting labels, then words
 * people might search for that aren't on screen. Keep it in step with the
 * section when adding or renaming a setting.
 */
export const SECTIONS: SettingsSection[] = [
  {
    id: 'wifi',
    group: 'Connections',
    name: 'Wi-Fi',
    icon: Wifi,
    search: ['Add network', 'Saved networks', 'Network details', 'network', 'internet', 'wireless', 'WLAN', 'SSID', 'hotspot', 'connection'],
  },
  {
    id: 'bluetooth',
    group: 'Connections',
    name: 'Bluetooth',
    icon: Bluetooth,
    search: ['My devices', 'Devices nearby', 'pair', 'headphones', 'speaker', 'mouse', 'keyboard', 'wireless', 'device'],
  },
  {
    id: 'phone',
    group: 'Connections',
    name: 'Phone',
    icon: Smartphone,
    search: ['My phones', 'Add an iPhone', 'Add an Android phone', 'Show Notifications', 'Sync Contacts', 'KDE Connect', 'Messages', 'texts', 'SMS', 'iMessage', 'Phone Link', 'Android', 'iPhone', 'mobile', 'cell'],
  },
  {
    id: 'appearance',
    group: 'Personal',
    name: 'Appearance',
    icon: Palette,
    search: ['Sync with your profile theme', 'Effects', 'Wobbly windows', 'Minimize effect', 'Close effect', 'Compiz', 'animation', 'genie', 'magic lamp', 'burn', 'explode', 'Cursor', 'Cursor style', 'Cursor size', 'theme', 'dark mode', 'light mode', 'colors', 'fonts', 'background', 'wallpaper', 'desktop picture', 'mouse pointer'],
  },
  {
    id: 'windows',
    group: 'Personal',
    name: 'Windows',
    icon: LayoutDashboard,
    search: ['Tiling', 'Tile windows', 'Gaps', 'Keyboard shortcuts', 'Workspaces', ...WM_BINDING_HELP.flatMap((g) => g.bindings.map((b) => b.label)), 'Hyprland', 'Omarchy', 'i3', 'sway', 'tiling window manager', 'virtual desktops', 'spaces', 'hotkeys', 'keybindings'],
  },
  {
    id: 'dock',
    group: 'Personal',
    name: 'Dock',
    icon: Dock,
    search: ['Size', 'Magnification', 'Magnification level', 'Background', 'None', 'Modern', 'Classic', 'magnify', 'zoom', 'taskbar', 'launcher', 'shelf', 'macOS'],
  },
  {
    id: 'notifications',
    group: 'Personal',
    name: 'Notifications',
    icon: Bell,
    search: ['Do Not Disturb', 'Keep notifications in the list without popping them up. Urgent ones still show.', 'Apps and sites', 'Installed nsites and websites that asked to show notifications.', 'Turn off notifications', 'Block', 'Forget', 'permissions', 'alerts', 'quiet', 'silence'],
  },
  {
    id: 'assistant',
    group: 'Personal',
    name: 'Assistant',
    icon: Bot,
    search: ['AI providers', 'OpenCode', 'AI', 'agent', 'chat', 'model', 'API key'],
  },
  {
    id: 'display',
    group: 'Devices',
    name: 'Display',
    icon: Monitor,
    search: ['Zoom', 'Scale everything on the desktop up or down.', 'AirPlay', 'monitor', 'screen', 'resolution', 'refresh rate', 'arrange', 'mirror', 'scaling', 'external display', 'projector', 'TV'],
  },
  {
    id: 'brightness',
    group: 'Devices',
    name: 'Brightness',
    icon: Sun,
    search: ['Night Light', "Warm the display's colors to reduce blue light.", 'Color temperature', 'Schedule', 'screen', 'dim', 'backlight', 'blue light'],
  },
  {
    id: 'sound',
    group: 'Devices',
    name: 'Sound',
    icon: Volume2,
    search: ['Output volume', 'Mute', 'Silence all output without losing your volume level.', 'Output device', 'Input device', 'Input volume', 'Play a test tone', 'volume', 'audio', 'speaker', 'headphones', 'microphone', 'mic'],
  },
  {
    id: 'keyboard',
    group: 'Devices',
    name: 'Keyboard',
    icon: Keyboard,
    search: ['Keyboard layout', 'The layout everything on this computer types with.', 'language', 'input', 'typing', 'QWERTY', 'Dvorak'],
  },
  {
    id: 'printers',
    group: 'Devices',
    name: 'Printers',
    icon: Printer,
    search: ['Add printer', 'Use as default', 'Print a test page', 'printing', 'print queue', 'scanner', 'CUPS'],
  },
  {
    id: 'power',
    group: 'Devices',
    name: 'Battery & Power',
    icon: BatteryFull,
    search: ['Battery', 'Power mode', 'Power profile', 'power saver', 'balanced', 'performance', 'charging', 'energy'],
  },
  {
    id: 'password',
    group: 'Account',
    name: 'Password',
    icon: KeyRound,
    search: ['Current password', 'New password', 'Changing it here changes it everywhere.', 'lock screen', 'login', 'security', 'disk encryption', 'passphrase', 'Running as administrator', 'Ask me to approve', 'Ask for the password', 'sudo', 'administrator', 'admin', 'root'],
  },
  {
    id: 'nostr',
    group: 'Account',
    name: 'Nostr & Storage',
    icon: Cloud,
    search: ['Encrypted sync', 'Relays', 'Blossom servers', 'Nostr links', 'Ask every time', 'sync', 'backup', 'cloud', 'media', 'uploads', 'NIP-65', 'NIP-21', 'default apps', 'open with'],
  },
  {
    id: 'connected',
    group: 'Account',
    name: 'Connected apps',
    icon: Link2,
    search: ['Connect an app', 'Sites and installed apps', 'Apps connected with a link', 'signer', 'bunker', 'Nostr Connect', 'remote signer', 'permissions', 'NIP-46'],
  },
  {
    id: 'datetime',
    group: 'System',
    name: 'Date & Time',
    icon: Clock,
    search: ['Time', 'Set time automatically', 'Time zone', 'Clock', 'Clock format', 'Show the date in the menu bar', 'The weekday and date, beside the time.', 'Show seconds in the menu bar', 'The clock ticks every second.', '24-hour', '12-hour', 'calendar', 'timezone'],
  },
  {
    id: 'about',
    group: 'System',
    name: 'About',
    icon: Info,
    search: [
      'Updates', 'Firmware', 'version', 'update', 'upgrade', 'restart', 'DinOS', 'system information',
      'Update automatically', 'commit', 'source', 'branch', 'fork', 'repository',
      'Login screen', 'Use Din as your desktop', 'Log in to Din by default', 'Roll back', 'Remove from login screen',
      'session', 'display manager', 'GDM', 'LightDM', 'desktop environment',
    ],
  },
  {
    id: 'developers',
    group: 'System',
    name: 'Developers',
    icon: Bug,
    search: ['Trigger an error', 'Crash', 'debug', 'error boundary'],
  },
];

/** The sections that match every one of the (parsed) search terms, in sidebar order. */
export function matchingSections(terms: string[]): SettingsSection[] {
  return SECTIONS.filter((s) => matchesAll([s.name, ...s.search], terms));
}
