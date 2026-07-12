/**
 * Device presets for the Web Browser's responsive/device view. Widths and
 * heights are CSS pixels; `deviceScaleFactor` is the device pixel ratio.
 * User-agent strings match the emulated device so sites doing UA sniffing
 * behave as they would on the real hardware (as Chrome's device toolbar does).
 */
export interface DevicePreset {
  /** Stable id used as the selected-device key. */
  id: string;
  /** Human-readable name shown in the picker. */
  name: string;
  /** Viewport width in CSS pixels. */
  width: number;
  /** Viewport height in CSS pixels. */
  height: number;
  /** Device pixel ratio. */
  deviceScaleFactor: number;
  /** Whether to emulate touch + a mobile viewport. */
  mobile: boolean;
  /** User-agent to advertise, or undefined to keep the desktop UA. */
  userAgent?: string;
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  {
    id: 'iphone-se',
    name: 'iPhone SE',
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: IPHONE_UA,
  },
  {
    id: 'iphone-14-pro',
    name: 'iPhone 14 Pro',
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: IPHONE_UA,
  },
  {
    id: 'pixel-7',
    name: 'Pixel 7',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent: ANDROID_UA,
  },
  {
    id: 'ipad-mini',
    name: 'iPad Mini',
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: IPAD_UA,
  },
  {
    id: 'ipad-pro',
    name: 'iPad Pro 11"',
    width: 834,
    height: 1194,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: IPAD_UA,
  },
  {
    id: 'surface-duo',
    name: 'Surface Duo',
    width: 540,
    height: 720,
    deviceScaleFactor: 2.5,
    mobile: true,
    userAgent: ANDROID_UA,
  },
  {
    id: 'laptop',
    name: 'Laptop',
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  },
  {
    id: 'desktop',
    name: 'Desktop',
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  },
];

/** Look up a device preset by id. */
export function findDevicePreset(id: string): DevicePreset | undefined {
  return DEVICE_PRESETS.find((preset) => preset.id === id);
}
