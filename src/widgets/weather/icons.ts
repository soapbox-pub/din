import { icon } from '../shared/dom';

/** Weather icons, Lucide's paths (ISC). */
const PATHS = {
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  partly: ['M12 2v2', 'm4.93 4.93 1.41 1.41', 'M20 12h2', 'm19.07 4.93-1.41 1.41', 'M15.947 12.65a4 4 0 0 0-5.925-4.128', 'M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z'],
  partlyNight: ['M10.188 8.5A6 6 0 0 1 16 4a1 1 0 0 0 6 6 6 6 0 0 1-3 5.197', 'M13 16a3 3 0 1 1 0 6H7a5 5 0 1 1 4.9-6Z'],
  cloud: ['M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z'],
  fog: ['M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242', 'M16 17H7', 'M17 21H9'],
  drizzle: ['M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242', 'M8 19v1', 'M8 14v1', 'M16 19v1', 'M16 14v1', 'M12 21v1', 'M12 16v1'],
  rain: ['M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242', 'M16 14v6', 'M8 14v6', 'M12 16v6'],
  snow: ['M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242', 'M8 15h.01', 'M8 19h.01', 'M12 17h.01', 'M12 21h.01', 'M16 15h.01', 'M16 19h.01'],
  storm: ['M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973', 'm13 12-3 5h4l-3 5'],
} as const;

export type WeatherIcon = keyof typeof PATHS;

export function weatherIcon(name: WeatherIcon, className = ''): SVGElement {
  return icon([...PATHS[name]], { class: `wx ${className}` });
}

export interface Condition {
  label: string;
  icon: WeatherIcon;
  /** The card's sky. */
  sky: 'clear' | 'cloudy' | 'rain' | 'snow' | 'storm' | 'fog';
}

/** WMO weather codes, as Open-Meteo gives them. */
export function condition(code: number, day: boolean): Condition {
  if (code === 0) return { label: day ? 'Sunny' : 'Clear', icon: day ? 'sun' : 'moon', sky: 'clear' };
  if (code === 1) return { label: 'Mostly clear', icon: day ? 'sun' : 'moon', sky: 'clear' };
  if (code === 2) return { label: 'Partly cloudy', icon: day ? 'partly' : 'partlyNight', sky: 'clear' };
  if (code === 3) return { label: 'Cloudy', icon: 'cloud', sky: 'cloudy' };
  if (code === 45 || code === 48) return { label: 'Fog', icon: 'fog', sky: 'fog' };
  if (code >= 51 && code <= 57) return { label: 'Drizzle', icon: 'drizzle', sky: 'rain' };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { label: code >= 65 || code === 82 ? 'Heavy rain' : 'Rain', icon: 'rain', sky: 'rain' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: 'Snow', icon: 'snow', sky: 'snow' };
  if (code >= 95) return { label: 'Thunderstorms', icon: 'storm', sky: 'storm' };
  return { label: 'Cloudy', icon: 'cloud', sky: 'cloudy' };
}
