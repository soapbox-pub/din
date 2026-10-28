import { sanitizeImageUrl as sanitizeWebImageUrl } from '@/lib/sanitizeUrl';

/**
 * An image URL an app hands the desktop (a window icon, a menu item's,
 * a notification's): https, a data: image, or a root path of Din's own
 * files (built-in apps' icons live in public/, served on both origins).
 */
export function sanitizeImageUrl(input: string): string | null {
  const trimmed = input.trim();
  if (/^\/(?!\/)[\w./-]+$/.test(trimmed) && !trimmed.includes('..')) return trimmed;
  return sanitizeWebImageUrl(trimmed);
}
