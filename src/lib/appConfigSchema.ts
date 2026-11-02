import { z } from 'zod';
import type { AppConfig, BlossomServerMetadata, RelayMetadata } from '@/contexts/AppContext';
import { DesktopThemeSchema, ProfileThemeMetadataSchema } from '@/lib/profileTheme';

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
  tilingEnabled: z.boolean(),
  tilingGap: z.number().min(0).max(64),
  restoreWindows: z.boolean(),
  desktopLayout: z.enum(['dock', 'taskbar']),
  dockMagnification: z.boolean(),
  dockMagnificationScale: z.number().min(1).max(3),
  dockSize: z.number().min(32).max(160),
  dockStyle: z.enum(['none', 'modern', 'classic']),
  taskbarStyle: z.enum(['tall', 'slim']),
  taskbarPosition: z.enum(['bottom', 'top', 'left', 'right']),
  taskbarButtons: z.enum(['combine', 'separate']),
  desktopIcons: z.boolean(),
  desktopIconSize: z.enum(['small', 'medium', 'large']),
  zoomLevel: z.number(),
  clockFormat: z.enum(['auto', '12', '24']),
  clockShowDate: z.boolean(),
  clockShowSeconds: z.boolean(),
  assistantEnabled: z.boolean(),
  assistantDirectory: z.string(),
  assistantColorfulReplies: z.boolean(),
}) satisfies z.ZodType<AppConfig>;
