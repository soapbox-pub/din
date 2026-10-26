import { extensionOf, isPlayableVideo, isViewableImage } from '@/lib/fileTypes';
import { getFsBridge, joinPath, localFileUrl, parentPath } from '@/lib/fs';
import { fileSource, readTags, type TrackTags } from './tags';

/**
 * Tags and cover art for songs, read once per location and cached for the
 * session. Covers are object URLs (for embedded art) or din-file: URLs (a
 * folder.jpg beside the songs, Windows Media Player's AlbumArt files).
 */

export type TrackInfo = Omit<TrackTags, 'picture'> & { hasPicture: boolean };

const infoCache = new Map<string, Promise<TrackInfo>>();
const pictureCache = new Map<string, { mime: string; data: Uint8Array } | null>();

export const isUrl = (location: string) => /^https?:\/\//i.test(location);

/** A song's name from its file name: "03 - Song.mp3" → "03 - Song". */
export function baseTitle(location: string): string {
  if (isUrl(location)) {
    try {
      const url = new URL(location);
      const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
      return last.replace(/\.[^.]+$/, '') || url.host;
    } catch {
      return location;
    }
  }
  const name = location.slice(location.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function mediaUrl(location: string): string {
  return isUrl(location) ? location : localFileUrl(location);
}

export function isVideoLocation(location: string): boolean {
  return !isUrl(location) && isPlayableVideo(location);
}

/** Everything the song's tags say (cached). Never rejects. */
export function trackInfo(location: string): Promise<TrackInfo> {
  let cached = infoCache.get(location);
  if (!cached) {
    cached = (async (): Promise<TrackInfo> => {
      if (isUrl(location) || !getFsBridge()) return { hasPicture: false };
      try {
        const { picture, ...rest } = await readTags(await fileSource(location));
        pictureCache.set(location, picture ?? null);
        return { ...rest, hasPicture: !!picture };
      } catch {
        return { hasPicture: false };
      }
    })();
    infoCache.set(location, cached);
  }
  return cached;
}

/** Forget a song's tags (it was edited or replaced). */
export function forgetTrackInfo(location: string): void {
  infoCache.delete(location);
  pictureCache.delete(location);
}

const coverCache = new Map<string, Promise<string | null>>();
const folderCoverCache = new Map<string, Promise<string | null>>();

const COVER_NAMES = ['folder', 'cover', 'front', 'album', 'albumart', 'albumartsmall', 'thumb'];

/** The picture a folder of songs keeps for itself, if any. */
function folderCover(dir: string): Promise<string | null> {
  let cached = folderCoverCache.get(dir);
  if (!cached) {
    cached = (async () => {
      const fs = getFsBridge();
      if (!fs) return null;
      try {
        const { entries } = await fs.readdir(dir);
        const images = entries.filter((e) => e.kind === 'file' && isViewableImage(e.name));
        const rank = (name: string) => {
          const base = name.slice(0, name.lastIndexOf('.')).toLowerCase();
          // Windows Media Player's AlbumArt_{GUID}_Large.jpg.
          if (/^albumart_\{.*\}_large$/.test(base)) return 0;
          const i = COVER_NAMES.indexOf(base);
          return i === -1 ? (/^albumart_/.test(base) ? 50 : null) : i + 1;
        };
        const best = images
          .map((e) => ({ e, r: rank(e.name) }))
          .filter((x): x is { e: typeof x.e; r: number } => x.r !== null)
          .sort((a, b) => a.r - b.r)[0];
        return best ? localFileUrl(joinPath(dir, best.e.name)) : null;
      } catch {
        return null;
      }
    })();
    folderCoverCache.set(dir, cached);
  }
  return cached;
}

/** A URL for a song's cover art, embedded or beside it, or null. */
export function coverFor(location: string): Promise<string | null> {
  let cached = coverCache.get(location);
  if (!cached) {
    cached = (async () => {
      if (isUrl(location)) return null;
      await trackInfo(location);
      const picture = pictureCache.get(location);
      if (picture && picture.data.length > 0) {
        return URL.createObjectURL(new Blob([picture.data.slice()], { type: picture.mime }));
      }
      return folderCover(parentPath(location));
    })();
    coverCache.set(location, cached);
  }
  return cached;
}

/** Audio Din can play, by extension. */
export const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'weba', 'webm', 'mp4', 'm4v', 'mkv', 'mov', 'ogv']);

export function isPlayableMedia(name: string): boolean {
  return AUDIO_EXTENSIONS.has(extensionOf(name));
}
