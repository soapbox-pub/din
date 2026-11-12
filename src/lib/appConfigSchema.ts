import { z } from 'zod';
import type { AppConfig, BlossomServerMetadata, RelayMetadata } from '@/contexts/AppContext';
import { DesktopThemeSchema, ProfileThemeMetadataSchema } from '@/lib/profileTheme';
import { COLOR_FILTERS } from '@/lib/accessibility';

// Zod schema for RelayMetadata validation
const RelayMetadataSchema = z.object({
  relays: z.array(z.object({
    url: z.url(),
    read: z.boolean(),
    write: z.boolean(),
  })),
  updatedAt: z.number(),
}) satisfies z.ZodType<RelayMetadata>;

// Zod schema for BlossomServerMetadata validation
const BlossomServerMetadataSchema = z.object({
  servers: z.array(z.url()),
  updatedAt: z.number(),
}) satisfies z.ZodType<BlossomServerMetadata>;

// Zod schema for AppConfig validation
export const AppConfigSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  syncToNostr: z.boolean(),
  relayMetadata: RelayMetadataSchema,
  blossomServerMetadata: BlossomServerMetadataSchema,
  useAppBlossomServers: z.boolean(),
  profileThemeMetadata: ProfileThemeMetadataSchema,
  customThemeEnabled: z.boolean(),
  syncProfileTheme: z.boolean(),
  localTheme: DesktopThemeSchema.nullable(),
  wobblyWindows: z.boolean(),
  gamePerformance: z.boolean(),
  resourceAlerts: z.boolean(),
  minimizeEffect: z.string(),
  closeEffect: z.string(),
  cursorTrail: z.string(),
  cursorClick: z.string(),
  cursorShowMouse: z.boolean(),
  cursorShakeToFind: z.boolean(),
  cursorFirePaint: z.boolean(),
  cursorWater: z.boolean(),
  cursorThemeColor: z.boolean(),
  powerMode: z.boolean(),
  powerModeShake: z.boolean(),
  mouseScrollDirection: z.enum(['auto', 'natural', 'traditional']),
  mouseTrackingSpeed: z.number().min(-1).max(1),
  mouseScrollSpeed: z.number().min(0.25).max(4),
  mouseSecondaryClick: z.enum(['right', 'left', 'off']),
  mouseMiddleClick: z.boolean(),
  mouseSwipe: z.enum(['pages', 'workspaces', 'off']),
  tilingEnabled: z.boolean(),
  tilingGap: z.number().min(0).max(64),
  restoreWindows: z.boolean(),
  pauseMediaWhileRecording: z.boolean(),
  volumeFeedback: z.boolean(),
  startupSound: z.boolean(),
  desktopLayout: z.enum(['dock', 'taskbar']),
  dockMagnification: z.boolean(),
  dockMagnificationScale: z.number().min(1).max(3),
  dockSize: z.number().min(32).max(160),
  dockStyle: z.enum(['none', 'modern', 'classic']),
  hiddenBadges: z.array(z.string()),
  taskbarStyle: z.enum(['tall', 'slim']),
  taskbarPosition: z.enum(['bottom', 'top', 'left', 'right']),
  taskbarButtons: z.enum(['combine', 'separate']),
  desktopIcons: z.boolean(),
  desktopIconSize: z.enum(['small', 'medium', 'large']),
  zoomLevel: z.number(),
  displayZoom: z.record(z.string(), z.number().min(50).max(300)),
  reduceMotion: z.boolean(),
  reduceTransparency: z.boolean(),
  // Astra was a third material for a while; it's Liquid now.
  glass: z.preprocess((v) => (v === 'astra' ? 'liquid' : v), z.enum(['liquid', 'frosted'])),
  increaseContrast: z.boolean(),
  textSize: z.number().min(100).max(200),
  screenZoomKeys: z.boolean(),
  colorFilter: z.enum(COLOR_FILTERS),
  stickyKeys: z.boolean(),
  slowKeys: z.boolean(),
  bounceKeys: z.boolean(),
  clockFormat: z.enum(['auto', '12', '24']),
  clockShowDate: z.boolean(),
  clockShowSeconds: z.boolean(),
  assistantEnabled: z.boolean(),
  assistantDirectory: z.string(),
  assistantColorfulReplies: z.boolean(),
}) satisfies z.ZodType<AppConfig>;
